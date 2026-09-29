/** Window-scoped native tools. Model arguments never select files or authority. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NormalizedRecord } from "./types.ts";
import type { PortableConfig } from "./config.ts";
import { validateApiKeyEnvName } from "./config.ts";
import type { AgentTool, AgentToolContext, AgentToolResult } from "./agent-runtime.ts";
import type { SupervisorSnapshot } from "./supervisor-types.ts";
import { canonical, digest, fail, integer, keys, object, oneOf, privateState, sha, str, underRoot } from "./security.ts";
import { runHelper, runScoringHelper, workerOptions } from "./worker.ts";

type JsonObject = Record<string, unknown>;
type Mode = "metadata" | "prepared_fragment" | "owner_selected_source";
type DataClass = AgentToolResult["dataClass"];
/** Display shorthand only. Consumers must resolve it uniquely inside their stored evidence scope. */
export function citationAlias(evidenceRef: string): string | null {
  const match = /^ptc-evidence:([a-f0-9]{64})$/u.exec(evidenceRef);
  return match ? "cite:" + match[1]!.slice(0, 16) : null;
}
export interface PtcHelperRequest {
  operation: "query" | "retrieve" | "context-pack";
  records: NormalizedRecord[];
  sourceRoot: string;
  filters?: JsonObject;
  fields?: string[];
  limit?: number;
  offset?: number;
  includeBody?: boolean;
  maxChars?: number;
}
export interface PtcHelperResult { value: unknown; execution: JsonObject }
export interface PtcHelperAdapter {
  invoke(request: PtcHelperRequest, signal: AbortSignal): Promise<PtcHelperResult>;
}
export interface PtcContentPolicy {
  native_content: "metadata" | "prepared_fragments" | "owner_selected_source";
  source_policy_id?: string;
  selected_record_handles?: string[];
  prepared_fragments?: {
    fragment_handle: string; record_handle: string; data_class: "synthetic" | "redacted";
    text: string; sha256: string; admission_ref: string;
  }[];
  prepared_packets?: {
    packet_handle: string; packet_sha256: string; prepared: unknown;
    admission_ref: string; attempt_budget: 0 | 1; result?: unknown;
  }[];
}
export interface PtcLimits {
  maxCalls?: number; maxInputBytes?: number; maxOutputBytes?: number;
  maxTotalOutputBytes?: number; maxReadBytes?: number; maxRecords?: number;
  maxExternalCalls?: number;
}
const DEFAULT_LIMITS = { maxCalls: 24, maxInputBytes: 8192, maxOutputBytes: 32768,
  maxTotalOutputBytes: 262144, maxReadBytes: 16 * 1024 * 1024, maxRecords: 100, maxExternalCalls: 0 };
/** Share one budget across all workers of an activation. Reservations are never refunded. */
export function createPtcBudget(limits: PtcLimits = {}) {
  keys(object(limits), Object.keys(DEFAULT_LIMITS));
  const bound = { ...DEFAULT_LIMITS, ...limits };
  integer(bound.maxCalls, 1, 256); integer(bound.maxInputBytes, 128, 32768);
  integer(bound.maxOutputBytes, 512, 131072); integer(bound.maxTotalOutputBytes, bound.maxOutputBytes, 1048576);
  integer(bound.maxReadBytes, 1, 64 * 1024 * 1024); integer(bound.maxRecords, 1, 1000);
  integer(bound.maxExternalCalls, 0, 1);
  let calls = 0, reservedOutput = 0, readBytes = 0, externalCalls = 0;
  return {
    limits: Object.freeze(bound),
    reserve(bytes: number): void {
      integer(bytes, 0, 8 * 1024 * 1024);
      if (calls + 1 > bound.maxCalls || reservedOutput + bound.maxOutputBytes > bound.maxTotalOutputBytes ||
          readBytes + bytes > bound.maxReadBytes) fail("ptc_budget_exhausted");
      calls++; reservedOutput += bound.maxOutputBytes; readBytes += bytes;
    },
    reserveExternal(): void {
      if (externalCalls >= bound.maxExternalCalls) fail("ptc_external_budget_exhausted");
      externalCalls++;
    },
    status: () => ({ calls, reserved_output_bytes: reservedOutput, reserved_read_bytes: readBytes, external_calls: externalCalls }),
  };
}
export type PtcBudget = ReturnType<typeof createPtcBudget>;
export interface PtcReceipt {
  schema_version: "task-checkpoint.ptc-receipt.v1";
  evidence_ref: string; activation_id: string; snapshot_sha256: string;
  binding_id: string; task_id: string; window_id: string;
  thread_id: string; turn_id: string; call_id: string; tool: string;
  sequence: number; status: "completed" | "failed"; error_code: string | null;
  arguments: unknown; arguments_sha256: string;
  result: AgentToolResult | null; result_sha256: string | null;
  record_handles: string[]; source_refs: unknown[]; helper: PtcHelperResult | null;
  external_attempt_reserved: boolean; scoring_config_sha256: string | null;
}
export interface PtcOptions {
  activationId: string;
  snapshot: SupervisorSnapshot;
  helper: PtcHelperAdapter;
  policy?: PtcContentPolicy;
  budget?: PtcBudget;
  /** Activation/lease validation is host authority, never a model argument. */
  assertActive: () => void | Promise<void>;
  /** Persist the exact bounded output before it is released to the native worker. */
  onReceipt: (receipt: PtcReceipt) => void | Promise<void>;
  scoring?: {
    selection: PortableConfig["scoring"];
    configSha256: string;
    /** Explicit installed helper scorePrepared adapter. No implicit import or fallback. */
    run: (prepared: unknown, selection: PortableConfig["scoring"], signal: AbortSignal) => Promise<unknown>;
  };
}
function jsonCopy<T>(value: T, cap: number): T {
  const visit = (v: unknown, depth: number): void => {
    if (depth > 32) fail("ptc_json_depth");
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    if (typeof v !== "object" || v === null || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail("ptc_json_required");
    for (const item of Object.values(v)) visit(item, depth + 1);
  };
  visit(value, 0);
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > cap) fail("ptc_json_budget");
  return JSON.parse(encoded) as T;
}
function valueAt(value: unknown, field: string): unknown {
  let selected: any = value;
  for (const key of field.split(".")) {
    if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) return null;
    selected = selected[key];
  }
  return selected;
}
const FIELDS = ["client", "kind", "timestamp", "native.session_id", "native.turn_id", "native.entry_id",
  "native.parent_entry_id", "native.trajectory_id", "native.step_id", "source.format", "source.version",
  "source.offset", "source.length", "source.sha256", "source.json_pointer", "labels", "text_available",
  "atif.session_id", "atif.trajectory_id", "atif.step_id", "logical.task_id", "logical.event_id", "logical.run_id",
  "logical.project_id", "relay.event_uuid", "native_actor.client"];
const DEFAULT_FIELDS = ["client", "kind", "timestamp", "source.format", "source.version", "text_available"];
const FILTERS = ["client", "kind", "native.session_id", "native.turn_id", "native.entry_id", "native.parent_entry_id",
  "native.trajectory_id", "native.step_id", "source.version", "atif.session_id", "atif.trajectory_id", "atif.step_id",
  "logical.task_id", "logical.event_id", "logical.run_id", "logical.project_id", "relay.event_uuid", "native_actor.client"];
function fieldsOf(value: unknown): string[] {
  const fields = value === undefined ? DEFAULT_FIELDS : value;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 24 || new Set(fields).size !== fields.length ||
      fields.some(field => typeof field !== "string" || !FIELDS.includes(field))) fail("ptc_unknown_field");
  return [...fields] as string[];
}
function filtersOf(value: unknown): JsonObject {
  const filters = object(value === undefined ? {} : value);
  keys(filters, FILTERS);
  for (const [key, value] of Object.entries(filters)) {
    if (key.endsWith(".step_id")) integer(value, 1, Number.MAX_SAFE_INTEGER);
    else if (key === "source.version" && (value === null || typeof value === "number")) {
      if (value !== null) integer(value, 0, Number.MAX_SAFE_INTEGER);
    } else str(value);
  }
  return filters;
}
function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  // Do not forward source paths, stderr, provider bodies or exception messages.
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "ptc_operation_failed";
}
function sourceBytes(records: NormalizedRecord[]): number {
  const ranges = new Map<string, number>();
  for (const record of records) for (const range of [record.source, ...Object.values(record.identity_evidence ?? {}),
    ...Object.values(record.atif_identity_evidence ?? {}), ...Object.values(record.native_actor_evidence ?? {})]) {
    ranges.set(canonical([record.source.uri, range.offset, range.length, range.sha256]), range.length);
  }
  return [...ranges.values()].reduce((a, b) => a + b, 0);
}
function schema(properties: JsonObject, required: string[] = []): JsonObject {
  return { type: "object", additionalProperties: false, properties, required };
}
const handleSchema = { type: "string", minLength: 1, maxLength: 512 };
const modeSchema = { type: "string", enum: ["metadata", "prepared_fragment", "owner_selected_source"] };
const filterSchema = schema(Object.fromEntries(FILTERS.map(name => [name,
  name.endsWith(".step_id") ? { type: "integer", minimum: 1 } : name === "source.version"
    ? { anyOf: [{ type: "string", minLength: 1, maxLength: 512 }, { type: "integer", minimum: 0 }, { type: "null" }] }
    : { type: "string", minLength: 1, maxLength: 512 }])));

/** Local admission preflight, before credential selection or any native/model call. */
export function validatePreparedPacketAdmission(value: unknown, selection?: PortableConfig["scoring"]): NonNullable<PtcContentPolicy["prepared_packets"]>[number] {
  const packet = object(jsonCopy(value, 2 * 1024 * 1024));
  keys(packet, ["packet_handle", "packet_sha256", "prepared", "admission_ref", "attempt_budget", "result"]);
  str(packet.packet_handle); str(packet.admission_ref); digest(packet.packet_sha256); integer(packet.attempt_budget, 0, 1);
  if ((packet.result === undefined) !== (packet.attempt_budget === 1)) fail("ptc_packet_attempt_policy_invalid");
  const prepared = object(jsonCopy(packet.prepared, 128 * 1024));
  keys(prepared, ["schema_version", "provider", "data_class", "request", "pair_map", "request_sha256", "request_bytes", "pair_map_sha256", "packet_sha256"]);
  const provider = oneOf(prepared.provider, ["openrouter", "typesafe"] as const);
  oneOf(prepared.data_class, ["synthetic", "redacted"] as const);
  const request = object(prepared.request), questions = object(request.questions), pairs = object(prepared.pair_map);
  keys(request, provider === "openrouter" ? ["model", "state", "questions", "provider"] : ["model", "state", "questions"]);
  if (provider === "openrouter") {
    const route = object(request.provider); keys(route, ["allow_fallbacks"]);
    if (route.allow_fallbacks !== false) fail("ptc_packet_routing_invalid");
  }
  const description = (v: unknown) => typeof v === "string" || v !== null && typeof v === "object";
  if (!description(request.state)) fail("ptc_packet_state_invalid");
  const names = Object.keys(questions); integer(names.length, 2, 64);
  for (const name of names) {
    str(name, 128); const q = object(questions[name]); keys(q, ["type", "instructions", "criteria"]);
    if (q.type !== "noul" || !description(q.instructions)) fail("ptc_packet_question_invalid");
    if (q.criteria !== undefined) { const criteria = object(q.criteria); keys(criteria, ["true", "false"]);
      if (!description(criteria.true) || !description(criteria.false)) fail("ptc_packet_question_invalid"); }
  }
  integer(Object.keys(pairs).length, 1, 32);
  const used = new Set<string>();
  for (const [id, raw] of Object.entries(pairs)) {
    str(id, 4096); const pair = object(raw); keys(pair, ["keepCall", "keepResult"]);
    for (const field of ["keepCall", "keepResult"]) {
      const name = str(pair[field], 128);
      if (!Object.hasOwn(questions, name) || used.has(name)) fail("ptc_packet_pair_invalid"); used.add(name);
    }
  }
  if (used.size !== names.length) fail("ptc_packet_pair_invalid");
  const body = canonical(request);
  if (prepared.schema_version !== "ultrafast-atif.prepared-decision.v1" ||
      request.model !== (provider === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0") ||
      prepared.request_bytes !== Buffer.byteLength(body) || prepared.request_bytes > Math.min(selection?.limits.max_request_bytes ?? 65536, 65536) ||
      prepared.request_sha256 !== sha(body) || prepared.pair_map_sha256 !== sha(canonical(pairs)) || prepared.packet_sha256 !== packet.packet_sha256 ||
      sha(canonical({ provider, data_class: prepared.data_class, request, pair_map: pairs })) !== packet.packet_sha256 ||
      selection && (provider !== selection.provider || request.model !== selection.model)) fail("ptc_packet_binding_mismatch");
  return packet as NonNullable<PtcContentPolicy["prepared_packets"]>[number];
}

/** CLI adapter uses only the explicitly configured installed/bundled command. */
export function createCliPtcHelper(options: { command: string[]; workDir: string; timeoutMs?: number; maxOutputBytes?: number }): PtcHelperAdapter {
  const command = [...options.command];
  const workDir = privateState(options.workDir);
  const timeoutMs = integer(options.timeoutMs ?? 10000, 100, 60000);
  const outputBytes = integer(options.maxOutputBytes ?? 2 * 1024 * 1024, 1024, 8 * 1024 * 1024);
  const worker = workerOptions({ helper: command, timeoutMs, leaseMs: Math.min(120000, timeoutMs + 1000), stdoutBytes: outputBytes });
  return { async invoke(request, signal) {
    if (signal.aborted) fail("ptc_cancelled");
    const input = Buffer.from(canonical(request.records) + "\n");
    if (input.length > 4 * 1024 * 1024) fail("ptc_metadata_budget");
    const directory = mkdtempSync(join(workDir, "ptc-"));
    const file = join(directory, "metadata.json");
    try {
      writeFileSync(file, input, { flag: "wx", mode: 0o600 });
      const argv = [...command, request.operation, "--input", file, "--allow-root", directory,
        "--allow-root", request.sourceRoot, "--max-bytes", String(8 * 1024 * 1024), "--json"];
      if (request.operation === "query") argv.push("--filters", canonical(request.filters ?? {}), "--fields", request.fields!.join(","),
        "--limit", String(request.limit), "--offset", String(request.offset));
      else {
        if (request.operation === "retrieve") argv.push("--record-id", request.records[0]!.record_id);
        argv.push("--max-chars", String(request.maxChars ?? 64000));
        if (request.includeBody) argv.push("--include-body");
      }
      const value = await runHelper(argv, worker, signal);
      if (signal.aborted) fail("ptc_cancelled");
      return { value, execution: { transport: "bounded_helper_subprocess", command_sha256: sha(canonical(command)),
        input_sha256: sha(input), input_bytes: input.length, output_sha256: sha(canonical(value)),
        timeout_ms: timeoutMs, stdout_cap: outputBytes, shell: false } };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } };
}

/** The caller supplies one selected transient key after activation admission. */
export function createCliPtcScorer(options: {
  command: string[]; workDir: string; config: PortableConfig; configSha256: string;
  credential: { envName: string; value: string };
}): NonNullable<PtcOptions["scoring"]> {
  const config = jsonCopy(options.config, 65536), configSha256 = digest(options.configSha256);
  if (sha(canonical(config)) !== configSha256) fail("ptc_scoring_config_digest_mismatch");
  const selection = config.scoring, command = [...options.command];
  if (canonical(command) !== canonical(config.recorder.helper_command)) fail("ptc_scoring_command_mismatch");
  const envName = validateApiKeyEnvName(options.credential.envName), key = options.credential.value;
  if (envName !== validateApiKeyEnvName(selection.api_key_env) ||
      typeof key !== "string" || key.length < 1 || key.length > 8192 || !/^[\x21-\x7e]+$/.test(key)) fail("ptc_scoring_credential_unavailable");
  const workDir = privateState(options.workDir);
  const worker = workerOptions({ helper: command, timeoutMs: selection.limits.deadline_ms + 1000,
    leaseMs: selection.limits.deadline_ms + 2000, stdoutBytes: Math.min(8 * 1024 * 1024, selection.limits.max_response_bytes + 65536) });
  let consumed = false;
  return { selection: jsonCopy(selection, 8192), configSha256, async run(prepared, selected, signal) {
    if (signal.aborted) fail("ptc_cancelled");
    if (canonical(selected) !== canonical(selection)) fail("ptc_scoring_selection_mismatch");
    const packet = object(jsonCopy(prepared, 128 * 1024));
    if (packet.provider !== selection.provider || packet.request?.model !== selection.model ||
        !["synthetic", "redacted"].includes(packet.data_class) || packet.request_bytes > selection.limits.max_request_bytes) fail("ptc_scoring_selection_mismatch");
    if (consumed) fail("ptc_scorer_attempt_consumed"); consumed = true;
    const directory = mkdtempSync(join(workDir, "ptc-score-"));
    try {
      const packetFile = join(directory, "prepared.json"), configFile = join(directory, "config.json");
      writeFileSync(packetFile, canonical(packet) + "\n", { flag: "wx", mode: 0o600 });
      writeFileSync(configFile, canonical(config) + "\n", { flag: "wx", mode: 0o600 });
      return await runScoringHelper([...command, "score-prepared", "--input", packetFile, "--allow-root", directory,
        "--config", configFile, "--deadline-ms", String(selection.limits.deadline_ms), "--json"], worker, { envName, value: key }, signal);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } };
}

export function createPtcTools(options: PtcOptions) {
  str(options.activationId);
  if (typeof options.assertActive !== "function" || typeof options.onReceipt !== "function" || typeof options.helper?.invoke !== "function") fail("ptc_host_contract_required");
  const snapshot = jsonCopy(options.snapshot, 4 * 1024 * 1024);
  const policy = jsonCopy<PtcContentPolicy>(options.policy ?? { native_content: "metadata" }, 2 * 1024 * 1024);
  const helperInvoke = options.helper.invoke.bind(options.helper), assertActive = options.assertActive, onReceipt = options.onReceipt;
  const scoring = options.scoring ? { selection: jsonCopy(options.scoring.selection, 8192), configSha256: digest(options.scoring.configSha256), run: options.scoring.run } : undefined;
  const invokeHelper = async (request: PtcHelperRequest, signal: AbortSignal) =>
    jsonCopy(await helperInvoke(jsonCopy(request, 4 * 1024 * 1024), signal), 8 * 1024 * 1024);
  const budget = options.budget ?? createPtcBudget();
  const limits = budget.limits;
  const snapshotDigest = digest(snapshot.snapshot_sha256);
  const { snapshot_sha256: _digest, ...snapshotBody } = snapshot;
  if (sha(canonical(snapshotBody)) !== snapshotDigest) fail("ptc_snapshot_digest_mismatch");
  const byHandle = new Map(snapshot.record_refs.map(ref => [ref.handle, ref]));
  const byId = new Map(snapshot.record_refs.map(ref => [ref.record_id, ref]));
  if (byHandle.size !== snapshot.record_refs.length || byId.size !== snapshot.record_refs.length || byHandle.size > 1000) fail("ptc_snapshot_records_invalid");
  const sourceUris = new Set(snapshot.sources.map(source => { underRoot(source.path, snapshot.source_root); return pathToFileURL(source.path).href; }));
  for (const ref of snapshot.record_refs) {
    str(ref.handle); str(ref.record_id); digest(ref.sha256);
    if (ref.record_id !== ref.metadata.record_id || sha(canonical(ref.metadata)) !== ref.sha256 || !sourceUris.has(ref.metadata.source.uri)) fail("ptc_record_binding_mismatch");
  }
  oneOf(policy.native_content, ["metadata", "prepared_fragments", "owner_selected_source"] as const);
  keys(policy as unknown as JsonObject, ["native_content", "source_policy_id", "selected_record_handles", "prepared_fragments", "prepared_packets"]);
  const selectedSource = new Set(policy.selected_record_handles ?? []);
  if (selectedSource.size !== (policy.selected_record_handles ?? []).length || [...selectedSource].some(handle => !byHandle.has(handle))) fail("ptc_content_selection_invalid");
  if (policy.native_content === "owner_selected_source") {
    str(policy.source_policy_id); if (selectedSource.size === 0) fail("ptc_source_policy_required");
  } else if (selectedSource.size || policy.source_policy_id !== undefined) fail("ptc_source_policy_invalid");
  const fragments = new Map<string, NonNullable<PtcContentPolicy["prepared_fragments"]>[number]>();
  const fragmentHandles = new Set<string>();
  for (const fragment of policy.prepared_fragments ?? []) {
    keys(fragment, ["fragment_handle", "record_handle", "data_class", "text", "sha256", "admission_ref"]);
    str(fragment.fragment_handle); str(fragment.admission_ref); digest(fragment.sha256);
    if (!byHandle.has(fragment.record_handle) || fragments.has(fragment.record_handle) || fragmentHandles.has(fragment.fragment_handle) || typeof fragment.text !== "string" ||
        Buffer.byteLength(fragment.text) > 64000 || sha(fragment.text) !== fragment.sha256) fail("ptc_fragment_invalid");
    oneOf(fragment.data_class, ["synthetic", "redacted"] as const); fragments.set(fragment.record_handle, fragment); fragmentHandles.add(fragment.fragment_handle);
  }
  if (fragments.size && policy.native_content !== "prepared_fragments") fail("ptc_fragment_policy_required");
  const packets = new Map<string, NonNullable<PtcContentPolicy["prepared_packets"]>[number]>();
  for (const raw of policy.prepared_packets ?? []) {
    const packet = validatePreparedPacketAdmission(raw, scoring?.selection);
    if (packets.has(packet.packet_handle)) fail("ptc_duplicate_packet");
    if (packet.result === undefined && (!scoring || packet.attempt_budget !== 1 || limits.maxExternalCalls !== 1)) fail("ptc_packet_execution_not_admitted");
    packets.set(packet.packet_handle, packet);
  }
  if (scoring) {
    const selection = scoring.selection;
    oneOf(selection.provider, ["openrouter", "typesafe"] as const);
    if (selection.model !== (selection.provider === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0") ||
        validateApiKeyEnvName(selection.api_key_env) !== selection.api_key_env) fail("ptc_scoring_selection_invalid");
    integer(selection.limits.deadline_ms, 1, 20000); integer(selection.limits.max_request_bytes, 1, 65536);
    integer(selection.limits.max_response_bytes, 1, 1048576);
    if (typeof scoring.run !== "function") fail("ptc_scoring_runner_required");
    for (const packet of packets.values()) {
      const prepared = object(packet.prepared);
      if (prepared.provider !== selection.provider || prepared.request.model !== selection.model || prepared.request_bytes > selection.limits.max_request_bytes) fail("ptc_scoring_selection_mismatch");
    }
  }
  const scope = { activation_id: options.activationId, binding_id: snapshot.binding_id, task_id: snapshot.task_id,
    window_id: snapshot.window_id, snapshot_sha256: snapshotDigest };
  const receipts: PtcReceipt[] = [];
  let sequenceCounter = 0;
  const consumedCalls = new Set<string>(), consumedPackets = new Set<string>();
  const pairHandle = (id: string) => "pair:" + sha(canonical([snapshotDigest, id]));
  const refOf = (handle: unknown) => byHandle.get(str(handle)) ?? fail("ptc_unknown_record_handle");
  const metadata = (handle: string, fields = DEFAULT_FIELDS) => {
    const record = refOf(handle).metadata;
    return { record_handle: handle, ...Object.fromEntries(fields.map(field => [field, valueAt(record, field)])) };
  };
  const requireMode = (mode: Mode, handles: string[]) => {
    if (mode === "prepared_fragment" && (policy.native_content !== "prepared_fragments" || handles.some(handle => !fragments.has(handle)))) fail("ptc_fragment_not_admitted");
    if (mode === "owner_selected_source" && (policy.native_content !== "owner_selected_source" || handles.some(handle => !selectedSource.has(handle)))) fail("ptc_source_not_admitted");
  };
  const dataClass = (mode: Mode, handles: string[]): DataClass => mode === "owner_selected_source" ? "owner_selected_source" :
    mode === "metadata" ? "metadata_only" : handles.some(handle => fragments.get(handle)!.data_class === "redacted") ? "redacted" : "synthetic";
  const modeOf = (value: unknown): Mode => oneOf(value === undefined ? "metadata" : value, ["metadata", "prepared_fragment", "owner_selected_source"] as const);
  const tools: AgentTool[] = [];
  function tool(name: string, description: string, inputSchema: JsonObject,
    validate: (args: JsonObject) => JsonObject,
    invoke: (args: JsonObject, context: AgentToolContext, note: { handles: string[]; helper: PtcHelperResult | null; external: boolean }) => Promise<AgentToolResult>) {
    const validateArguments = (value: unknown) => validate(object(jsonCopy(value, limits.maxInputBytes)));
    tools.push({ name, description, inputSchema: jsonCopy(inputSchema, 32768), validateArguments,
      async execute(raw, context) {
        const args = validateArguments(raw);
        str(context.threadId); str(context.turnId); str(context.callId);
        if (context.signal.aborted) fail("ptc_cancelled");
        try { await assertActive(); } catch (error) { fail(errorCode(error)); }
        const callKey = canonical([context.threadId, context.turnId, context.callId]);
        if (consumedCalls.has(callKey)) fail("ptc_duplicate_call");
        consumedCalls.add(callKey);
        const handles = Array.isArray(args.record_handles) ? args.record_handles as string[] : typeof args.record_handle === "string" ? [args.record_handle] : [];
        const readBytes = name === "tcr_query" || name === "tcr_score_prepared" ? 0 : sourceBytes(handles.map(handle => refOf(handle).metadata));
        budget.reserve(readBytes);
        const sequence = ++sequenceCounter;
        const evidenceRef = "ptc-evidence:" + sha(canonical([scope, context.threadId, context.turnId, context.callId, name, args]));
        const receipt: PtcReceipt = { schema_version: "task-checkpoint.ptc-receipt.v1", ...scope,
          evidence_ref: evidenceRef, thread_id: context.threadId, turn_id: context.turnId, call_id: context.callId, tool: name,
          sequence, status: "failed", error_code: null, arguments: args, arguments_sha256: sha(canonical(args)), result: null, result_sha256: null,
          record_handles: handles, source_refs: handles.map(handle => ({ record_handle: handle, metadata_sha256: refOf(handle).sha256, source: refOf(handle).metadata.source })),
          helper: null, external_attempt_reserved: false, scoring_config_sha256: scoring?.configSha256 ?? null };
        const note = { handles, helper: null as PtcHelperResult | null, external: false };
        try {
          const result = await invoke(args, context, note);
          if (context.signal.aborted) fail("ptc_cancelled");
          await assertActive();
          result.value = { ...object(result.value), schema_version: "task-checkpoint.ptc-result.v1", tool: name,
            ...scope, evidence_ref: evidenceRef, citation_ref: citationAlias(evidenceRef)! };
          receipt.result = jsonCopy(result, limits.maxOutputBytes); receipt.result_sha256 = sha(canonical(receipt.result));
          receipt.status = "completed";
        } catch (error) { receipt.error_code = errorCode(error); }
        receipt.record_handles = note.handles; receipt.helper = note.helper; receipt.external_attempt_reserved = note.external;
        receipt.source_refs = note.handles.map(handle => ({ record_handle: handle, metadata_sha256: refOf(handle).sha256, source: refOf(handle).metadata.source }));
        // The sink is private host storage; source locators never enter the model value.
        const sealed = jsonCopy(receipt, 8 * 1024 * 1024);
        try { await onReceipt(sealed); } catch { fail("ptc_receipt_persistence_failed"); }
        receipts.push(jsonCopy(receipt, 8 * 1024 * 1024));
        if (receipt.status !== "completed") fail(receipt.error_code!);
        return receipt.result!;
      },
    });
  }
  tool("tcr_query", "Query metadata only within the frozen task window. Use returned record handles for retrieval; source paths are unavailable.",
    schema({ filters: filterSchema, fields: { type: "array", items: { type: "string", enum: FIELDS }, minItems: 1, maxItems: 24, uniqueItems: true },
      limit: { type: "integer", minimum: 1, maximum: 1000 }, offset: { type: "integer", minimum: 0, maximum: 1000 } }), args => {
      keys(args, ["filters", "fields", "limit", "offset"]);
      return { filters: filtersOf(args.filters), fields: fieldsOf(args.fields), limit: integer(args.limit ?? Math.min(20, limits.maxRecords), 1, limits.maxRecords), offset: integer(args.offset ?? 0, 0, 1000) };
    }, async (args, context, note) => {
      const fields = args.fields as string[];
      const all = snapshot.record_refs.map(ref => ref.metadata);
      const response = await invokeHelper({ operation: "query", records: all, sourceRoot: snapshot.source_root,
        filters: args.filters as JsonObject, fields: ["/record_id"],
        limit: args.limit as number, offset: args.offset as number }, context.signal);
      note.helper = response;
      const value = object(response.value);
      if (value.schema_version !== "ultrafast-atif.query.v1" || value.sources_opened !== false || !Array.isArray(value.records) || value.records.length > (args.limit as number)) fail("ptc_helper_contract");
      const handles = value.records.map((row: unknown) => {
        const item = object(row), ref = byId.get(str(item["/record_id"]));
        if (!ref || !Object.entries(args.filters as JsonObject).every(([key, expected]) => canonical(valueAt(ref.metadata, key)) === canonical(expected))) fail("ptc_helper_scope_mismatch");
        return ref.handle;
      });
      if (new Set(handles).size !== handles.length) fail("ptc_helper_duplicate_record");
      note.handles = handles;
      const next = value.next_offset === null ? null : integer(value.next_offset, (args.offset as number) + 1, snapshot.record_refs.length);
      return { dataClass: "metadata_only", value: { records: handles.map(handle => metadata(handle, fields)),
        matched: integer(value.matched, handles.length, snapshot.record_refs.length), next_offset: next, source_bytes_verified: false } };
    });
  tool("tcr_get", "Verify a selected record against its source bytes. Metadata is the default; prepared/source text requires prior host admission.",
    schema({ record_handle: handleSchema, mode: modeSchema, max_chars: { type: "integer", minimum: 1, maximum: 64000 } }, ["record_handle"]), args => {
      keys(args, ["record_handle", "mode", "max_chars"]); const ref = refOf(args.record_handle); const mode = modeOf(args.mode);
      requireMode(mode, [ref.handle]); return { record_handle: ref.handle, mode, max_chars: integer(args.max_chars ?? 4096, 1, 64000) };
    }, async (args, context, note) => {
      const handle = args.record_handle as string, ref = refOf(handle), mode = args.mode as Mode;
      const response = await invokeHelper({ operation: "retrieve", records: [ref.metadata], sourceRoot: snapshot.source_root,
        includeBody: mode === "owner_selected_source", maxChars: args.max_chars as number }, context.signal);
      note.helper = response; const value = object(response.value);
      if (value.schema_version !== "ultrafast-atif.retrieval.v1" || value.record_id !== ref.record_id || value.source_verified !== true || value.identity_verified !== true ||
          canonical(value.source) !== canonical(ref.metadata.source) || value.body_included !== (mode === "owner_selected_source")) fail("ptc_helper_retrieval_mismatch");
      const output: JsonObject = { metadata: metadata(handle, FIELDS), source_verified: true, identity_verified: true,
        identity_verification_scope: "selected_source_values_only", referenced_provenance_followed: false, body_included: mode !== "metadata" };
      if (mode === "prepared_fragment") {
        const fragment = fragments.get(handle)!; output.text = fragment.text.slice(0, args.max_chars as number);
        output.fragment_handle = fragment.fragment_handle; output.fragment_sha256 = fragment.sha256; output.truncated = fragment.text.length > (args.max_chars as number);
      } else if (mode === "owner_selected_source") {
        if (typeof value.text !== "string" || value.text.length > (args.max_chars as number)) fail("ptc_helper_body_budget");
        output.text = value.text; output.truncated = value.truncated === true;
        output.source_policy_id = policy.source_policy_id; output.text_transform = "helper_bounded_pattern_redaction_not_external_admission";
      }
      return { dataClass: dataClass(mode, [handle]), value: output };
    });
  tool("tcr_context_pack", "Build a pair-preserving verified context view from selected handles. This never calls a model, rewrites sources or deletes records.",
    schema({ record_handles: { type: "array", items: handleSchema, minItems: 1, maxItems: 1000, uniqueItems: true }, mode: modeSchema,
      max_chars: { type: "integer", minimum: 1, maximum: 64000 } }, ["record_handles"]), args => {
      keys(args, ["record_handles", "mode", "max_chars"]);
      if (!Array.isArray(args.record_handles) || args.record_handles.length < 1 || args.record_handles.length > limits.maxRecords || new Set(args.record_handles).size !== args.record_handles.length) fail("ptc_record_limit");
      const handles = args.record_handles.map(handle => refOf(handle).handle), mode = modeOf(args.mode); requireMode(mode, handles);
      return { record_handles: handles, mode, max_chars: integer(args.max_chars ?? 16000, 1, 64000) };
    }, async (args, context, note) => {
      const requested = new Set(args.record_handles as string[]), mode = args.mode as Mode;
      const refs = snapshot.record_refs.filter(ref => requested.has(ref.handle));
      const response = await invokeHelper({ operation: "context-pack", records: refs.map(ref => ref.metadata), sourceRoot: snapshot.source_root,
        includeBody: mode === "owner_selected_source", maxChars: args.max_chars as number }, context.signal);
      note.helper = response; const value = object(response.value);
      if (value.schema_version !== "ultrafast-atif.context-pack.v1" || value.model_called !== false || value.original_sources_rewritten !== false ||
          value.body_included !== (mode === "owner_selected_source") || !Array.isArray(value.records) || value.records.length > refs.length || !Array.isArray(value.decisions) || value.decisions.length > 1000) fail("ptc_helper_context_mismatch");
      let textLength = 0;
      const records = value.records.map((row: unknown) => {
        const item = object(row), ref = byId.get(str(object(item.record).record_id));
        if (!ref || !requested.has(ref.handle) || canonical(item.record) !== canonical(ref.metadata)) fail("ptc_helper_scope_mismatch");
        const result: JsonObject = { ...metadata(ref.handle), view: oneOf(item.view, ["verbatim", "truncated_head"] as const) };
        if (mode !== "metadata") {
          const text = mode === "prepared_fragment" ? fragments.get(ref.handle)!.text : item.text;
          if (typeof text !== "string") fail("ptc_helper_body_invalid"); textLength += text.length; result.text = text;
          if (mode === "prepared_fragment") {
            result.source_view = result.view; result.view = "prepared_fragment";
            result.fragment_handle = fragments.get(ref.handle)!.fragment_handle;
            result.fragment_sha256 = fragments.get(ref.handle)!.sha256;
          }
        }
        return result;
      });
      if (new Set(records.map(record => record.record_handle)).size !== records.length || textLength > (args.max_chars as number)) fail("ptc_context_budget");
      const decisions = value.decisions.map((raw: unknown) => {
        const decision = object(raw); if (!Array.isArray(decision.record_ids)) fail("ptc_helper_context_mismatch");
        return { pair_handle: pairHandle(str(decision.pair_id, 16384)), action: oneOf(decision.action, ["keep", "drop_call", "drop_result"] as const),
          record_handles: decision.record_ids.map((id: unknown) => { const ref = byId.get(str(id)); if (!ref || !requested.has(ref.handle)) fail("ptc_helper_scope_mismatch"); return ref.handle; }) };
      });
      if (typeof value.pairs_complete !== "boolean" || !Array.isArray(value.omissions) || value.omissions.length > 32) fail("ptc_helper_context_mismatch");
      return { dataClass: dataClass(mode, [...requested]), value: { records, decisions, pairs_complete: value.pairs_complete,
        omissions: value.omissions.map((item: unknown) => str(item, 512)), body_included: mode !== "metadata", model_called: false,
        original_sources_rewritten: false, source_records: refs.length, omitted_records: refs.length - records.length,
        ...(mode === "owner_selected_source" ? { source_policy_id: policy.source_policy_id, text_transform: "helper_bounded_pattern_redaction_not_external_admission" } : {}) } };
    });
  if (packets.size) tool("tcr_score_prepared", "Read scores for an immutable host-admitted synthetic/redacted packet, or use its explicitly admitted single attempt. No source text can be supplied.",
    schema({ packet_handle: handleSchema }, ["packet_handle"]), args => {
      keys(args, ["packet_handle"]); const handle = str(args.packet_handle);
      if (!packets.has(handle)) fail("ptc_unknown_packet_handle"); return { packet_handle: handle };
    }, async (args, context, note) => {
      const packet = packets.get(args.packet_handle as string)!; const prepared = object(packet.prepared);
      let raw = packet.result;
      if (raw === undefined) {
        if (consumedPackets.has(packet.packet_handle)) fail("ptc_packet_attempt_consumed");
        budget.reserveExternal(); consumedPackets.add(packet.packet_handle); note.external = true;
        raw = await scoring!.run(jsonCopy(prepared, 128 * 1024), jsonCopy(scoring!.selection, 8192), context.signal);
      }
      note.helper = { value: raw, execution: { transport: note.external ? "explicit_scoring_adapter" : "precomputed_scoring_receipt",
        packet_sha256: packet.packet_sha256, admission_ref: packet.admission_ref, config_sha256: scoring?.configSha256 ?? null } };
      const result = object(jsonCopy(raw, 1048576)), evidence = object(result.evidence);
      if (result.schema_version !== "ultrafast-atif.decision-result.v1" || result.status !== "valid_response" || result.data_class !== prepared.data_class ||
          result.provider_profile !== prepared.provider || result.requested_model !== prepared.request.model || evidence.packet_sha256 !== packet.packet_sha256 ||
          evidence.request_sha256 !== prepared.request_sha256 || evidence.pair_map_sha256 !== prepared.pair_map_sha256 ||
          result.http_attempts !== 1 || result.model_called !== true || result.response_identity_namespace !== prepared.provider ||
          !(result.model === prepared.request.model && result.model_verification === "exact_match" || prepared.provider === "typesafe" && result.model === null && result.model_verification === "unavailable") ||
          result.compaction_applied !== false || result.source_paths_loaded !== false || result.deletion_authorized !== false) fail("ptc_score_binding_mismatch");
      const scores = object(result.scores), pairs = object(prepared.pair_map);
      if (Object.keys(scores).sort().join("\u0000") !== Object.keys(pairs).sort().join("\u0000")) fail("ptc_score_identity_mismatch");
      const rows = Object.entries(scores).map(([id, raw]) => { const score = object(raw); keys(score, ["keepCall", "keepResult"]);
        if (![score.keepCall, score.keepResult].every(p => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1)) fail("ptc_score_invalid");
        return { pair_handle: pairHandle(id), keep_call: score.keepCall, keep_result: score.keepResult }; });
      return { dataClass: "metadata_only", value: { packet_handle: packet.packet_handle, packet_sha256: packet.packet_sha256,
        score_sha256: sha(canonical(result)), scores: rows, scoring_mode: note.external ? "admitted_single_attempt" : "precomputed",
        calibration: "not_established", compaction_applied: false, deletion_authorized: false } };
    });
  return { tools, catalogue: { ...scope, record_count: byHandle.size, content_policy: policy.native_content,
    limits: { ...limits }, packet_handles: [...packets.keys()], prepared_fragment_record_handles: [...fragments.keys()] },
    receipts: () => jsonCopy(receipts, 32 * 1024 * 1024), budget };
}

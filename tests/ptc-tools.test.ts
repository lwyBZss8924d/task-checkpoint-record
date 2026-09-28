import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCliPtcHelper, createCliPtcScorer, createPtcBudget, createPtcTools, validatePreparedPacketAdmission } from "../src/ptc-tools.ts";
import type { PtcContentPolicy, PtcHelperAdapter, PtcOptions, PtcReceipt } from "../src/ptc-tools.ts";
import type { AgentToolContext } from "../src/agent-runtime.ts";
import type { NormalizedRecord } from "../src/types.ts";
import type { SupervisorSnapshot } from "../src/supervisor-types.ts";
import { canonical, fail, sha } from "../src/security.ts";
import { configTemplate } from "../src/config.ts";
import { runHelper, workerOptions } from "../src/worker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ptc-test-"))); roots.push(root);
  const sources = join(root, "sources"), work = join(root, "work"); mkdirSync(sources, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
  return { root, sources, work };
}
function seal(snapshot: Omit<SupervisorSnapshot, "snapshot_sha256">): SupervisorSnapshot {
  return { ...snapshot, snapshot_sha256: sha(canonical(snapshot)) };
}
function fixture() {
  const w = workspace(), source = join(w.sources, "source.jsonl");
  const lines = [{ type: "message", text: "SYNTHETIC_BODY_A" }, { type: "message", text: "SYNTHETIC_BODY_B" }].map(row => JSON.stringify(row) + "\n");
  writeFileSync(source, lines.join(""), { mode: 0o600 }); let offset = 0;
  const records: NormalizedRecord[] = lines.map((line, index) => {
    const record: NormalizedRecord = { record_id: "synthetic-record-" + index, client: "codex", kind: index === 0 ? "call" : "result", timestamp: null,
      native: { session_id: null, turn_id: null, entry_id: null, parent_entry_id: null, trajectory_id: null, step_id: null },
      source: { uri: pathToFileURL(source).href, format: "codex", version: null, offset, length: Buffer.byteLength(line), sha256: sha(line), json_pointer: "" },
      identity_evidence: {}, labels: [], text_available: true };
    offset += Buffer.byteLength(line); return record;
  });
  return { ...w, source, records, snapshot: snapshotFor(w.sources, source, records) };
}
function snapshotFor(root: string, source: string, records: NormalizedRecord[]): SupervisorSnapshot {
  return seal({ schema_version: "task-checkpoint-record.supervisor-snapshot.v1", store_id: "synthetic-store", binding_id: "binding-A",
    task_id: "task-A", window_id: "window-A", window_sha256: sha("window"), binding_sha256: sha("binding"), created_at: "2026-01-01T00:00:00Z",
    task_native: { client: "codex", profile: "synthetic", session_id: "session-A", hook_turn_id: null }, source_root: root,
    sources: [{ source_id: "source-A", path: source, format: "codex" }],
    record_refs: records.map(metadata => ({ handle: "record:" + sha(metadata.record_id), record_id: metadata.record_id, sha256: sha(canonical(metadata)), metadata })),
    page_refs: [], coverage: { kind: "metadata_only", selected_records: records.length, total_records: records.length, truncated: false, omissions: [] } });
}
function at(value: unknown, field: string): unknown { return field.split(".").reduce<any>((v, key) => v?.[key] ?? null, value); }
function mockHelper() {
  let calls = 0;
  const adapter: PtcHelperAdapter = { async invoke(request, signal) {
    calls++; if (signal.aborted) fail("helper_cancelled");
    const verify = (record: NormalizedRecord) => {
      const fd = openSync(fileURLToPath(record.source.uri), "r");
      const bytes = Buffer.alloc(record.source.length); try { readSync(fd, bytes, 0, bytes.length, record.source.offset); } finally { closeSync(fd); }
      if (sha(bytes) !== record.source.sha256) fail("source_stale"); return JSON.parse(bytes.toString()).text;
    };
    let value: unknown;
    if (request.operation === "query") {
      const selected = request.records.filter(record => Object.entries(request.filters ?? {}).every(([key, expected]) => canonical(at(record, key)) === canonical(expected)));
      const rows = selected.slice(request.offset!, request.offset! + request.limit!);
      value = { schema_version: "ultrafast-atif.query.v1", records: rows.map(record => ({ "/record_id": record.record_id })),
        matched: selected.length, next_offset: request.offset! + rows.length < selected.length ? request.offset! + rows.length : null, sources_opened: false };
    } else if (request.operation === "retrieve") {
      const record = request.records[0]!, text = verify(record);
      value = { schema_version: "ultrafast-atif.retrieval.v1", record_id: record.record_id, source: record.source,
        source_verified: true, identity_verified: true, body_included: request.includeBody === true,
        ...(request.includeBody ? { text: text.slice(0, request.maxChars), truncated: false } : {}) };
    } else {
      value = { schema_version: "ultrafast-atif.context-pack.v1", model_called: false, original_sources_rewritten: false,
        body_included: request.includeBody === true, source_records: request.records.length, omitted_records: 0, pairs_complete: true, omissions: [],
        decisions: [{ pair_id: "file:///host-private/source:pair-A", action: "keep", record_ids: request.records.map(record => record.record_id) }],
        records: request.records.map(record => { const text = verify(record); return { record, view: "verbatim", ...(request.includeBody ? { text } : {}) }; }) };
    }
    return { value, execution: { transport: "synthetic_test_adapter", call: calls } };
  } };
  return { adapter, calls: () => calls };
}
const context = (id = "call-1", signal = new AbortController().signal): AgentToolContext => ({ signal, threadId: "worker-thread", turnId: "worker-turn", callId: id });
function setup(extra: Partial<PtcOptions> = {}) {
  const f = fixture(), helper = mockHelper(), stored: PtcReceipt[] = [];
  const bridge = createPtcTools({ activationId: "activation-A", snapshot: f.snapshot, helper: helper.adapter,
    assertActive: () => {}, onReceipt: receipt => { stored.push(receipt); }, ...extra });
  return { ...f, helper, stored, bridge, call: (name: string, args: unknown, ctx = context()) => bridge.tools.find(tool => tool.name === name)!.execute(args, ctx) };
}
function packetFixture() {
  const request = { model: "typesafe/jev-1.13-20260917", provider: { allow_fallbacks: false }, state: "Synthetic task constraints only.",
    questions: { call: { type: "noul", instructions: "Keep this synthetic call?" }, result: { type: "noul", instructions: "Keep this synthetic result?" } } };
  const pair_map = { "file:///synthetic-private/pair": { keepCall: "call", keepResult: "result" } };
  const prepared = { schema_version: "ultrafast-atif.prepared-decision.v1", provider: "openrouter", data_class: "synthetic", request, pair_map,
    request_sha256: sha(canonical(request)), request_bytes: Buffer.byteLength(canonical(request)), pair_map_sha256: sha(canonical(pair_map)),
    packet_sha256: sha(canonical({ provider: "openrouter", data_class: "synthetic", request, pair_map })) };
  const result = { schema_version: "ultrafast-atif.decision-result.v1", data_class: "synthetic", status: "valid_response", http_attempts: 1, model_called: true,
    provider_profile: "openrouter", requested_model: request.model, model: request.model, model_verification: "exact_match", response_identity_namespace: "openrouter",
    scores: { "file:///synthetic-private/pair": { keepCall: 0, keepResult: 0.75 } }, source_paths_loaded: false, compaction_applied: false, deletion_authorized: false,
    evidence: { packet_sha256: prepared.packet_sha256, request_sha256: prepared.request_sha256, pair_map_sha256: prepared.pair_map_sha256 } };
  return { prepared, result, packet: { packet_handle: "packet:synthetic", packet_sha256: prepared.packet_sha256, prepared, admission_ref: "admission:owner-synthetic", attempt_budget: 0 as const, result } };
}

test("query returns scoped opaque handles, exact fields and pagination without source locators or bodies", async () => {
  const s = setup(); const output = await s.call("tcr_query", { fields: ["kind", "atif.session_id"], limit: 1 });
  const value = output.value as any;
  expect(value.records).toEqual([{ record_handle: s.snapshot.record_refs[0]!.handle, kind: "call", "atif.session_id": null }]);
  expect(value.next_offset).toBe(1); expect(value.source_bytes_verified).toBe(false);
  expect(JSON.stringify(output)).not.toContain(s.source); expect(JSON.stringify(output)).not.toContain("SYNTHETIC_BODY");
  expect(s.stored[0]!.result_sha256).toBe(sha(canonical(output))); expect(s.stored[0]!.source_refs.length).toBe(1);
  expect(s.stored[0]!.helper?.execution.transport).toBe("synthetic_test_adapter");
});
test("task/window/path/URL widening, unknown fields and invalid scalar filters fail before helper use", async () => {
  const s = setup();
  for (const args of [{ task_id: "task-B" }, { window_id: "window-B" }, { path: s.source }, { filters: { task_id: "task-B" } },
    { fields: ["source.uri"] }, { filters: { "native.session_id": null } }, { filters: { "native.turn_id": false } },
    { filters: { "native.session_id": 0 } }, { filters: { "native.session_id": "" } }, { offset: -1 }, { limit: 0 }, { limit: 1.5 }]) {
    await expect(s.call("tcr_query", args)).rejects.toBeDefined();
  }
  await expect(s.call("tcr_get", { record_handle: "record:other-task" })).rejects.toBeDefined();
  expect(s.helper.calls()).toBe(0);
});
test("snapshot copy remains immutable after caller edits and modified digests fail preflight", async () => {
  const s = setup(); s.snapshot.record_refs[0]!.metadata.kind = "MUTATED";
  const output = await s.call("tcr_query", { fields: ["kind"] });
  expect((output.value as any).records[0].kind).toBe("call");
  expect(() => createPtcTools({ activationId: "a", snapshot: s.snapshot, helper: s.helper.adapter, assertActive: () => {}, onReceipt: () => {} })).toThrow("ptc_snapshot_digest_mismatch");
});
test("helper output from an unselected record cannot cross the frozen scope", async () => {
  const s = setup({ helper: { async invoke() { return { value: { schema_version: "ultrafast-atif.query.v1", sources_opened: false,
    records: [{ "/record_id": "foreign-record" }], matched: 1, next_offset: null }, execution: {} }; } } });
  await expect(s.call("tcr_query", {})).rejects.toThrow("ptc_helper_scope_mismatch");
  expect(s.stored[0]!.status).toBe("failed"); expect(s.stored[0]!.result).toBeNull();
});
test("metadata retrieval verifies source and keeps paths/body in private evidence only", async () => {
  const s = setup(), handle = s.snapshot.record_refs[0]!.handle;
  const result = await s.call("tcr_get", { record_handle: handle });
  expect(result.dataClass).toBe("metadata_only"); expect((result.value as any).source_verified).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_BODY"); expect(JSON.stringify(result)).not.toContain("file:");
  expect(s.stored[0]!.source_refs).toHaveLength(1);
  writeFileSync(s.source, "stale source\n");
  await expect(s.call("tcr_get", { record_handle: handle }, context("next"))).rejects.toThrow("source_stale");
});
test("text modes require exact owner admission, never model-declared redaction", async () => {
  const s = setup(), handle = s.snapshot.record_refs[0]!.handle;
  for (const mode of ["prepared_fragment", "owner_selected_source", "redacted"]) await expect(s.call("tcr_get", { record_handle: handle, mode })).rejects.toBeDefined();
  await expect(s.call("tcr_get", { record_handle: handle, mode: "metadata", data_class: "redacted", text: "model text" })).rejects.toBeDefined();
  expect(s.helper.calls()).toBe(0);
});
test("prepared fragments are copied, hash-bound and preserve their admitted data class", async () => {
  const f = fixture(), helper = mockHelper(), handle = f.snapshot.record_refs[0]!.handle;
  const policy: PtcContentPolicy = { native_content: "prepared_fragments", prepared_fragments: [{ fragment_handle: "fragment:one", record_handle: handle,
    data_class: "redacted", text: "Owner-prepared excerpt", sha256: sha("Owner-prepared excerpt"), admission_ref: "owner:admission" }] };
  const bridge = createPtcTools({ activationId: "a", snapshot: f.snapshot, helper: helper.adapter, policy, assertActive: () => {}, onReceipt: () => {} });
  policy.prepared_fragments![0]!.text = "caller changed";
  const result = await bridge.tools.find(t => t.name === "tcr_get")!.execute({ record_handle: handle, mode: "prepared_fragment", max_chars: 14 }, context());
  expect(result.dataClass).toBe("redacted"); expect((result.value as any).text).toBe("Owner-prepared"); expect((result.value as any).truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_BODY");
  const pack = await bridge.tools.find(t => t.name === "tcr_context_pack")!.execute({ record_handles: [handle], mode: "prepared_fragment" }, context("fragment-pack"));
  expect((pack.value as any).records[0]).toMatchObject({ view: "prepared_fragment", source_view: "verbatim", fragment_sha256: sha("Owner-prepared excerpt") });
});
test("owner selected source content has a distinct truthful class and exact handle scope", async () => {
  const f = fixture(), helper = mockHelper(), handle = f.snapshot.record_refs[0]!.handle;
  const bridge = createPtcTools({ activationId: "a", snapshot: f.snapshot, helper: helper.adapter,
    policy: { native_content: "owner_selected_source", source_policy_id: "policy:owner", selected_record_handles: [handle] }, assertActive: () => {}, onReceipt: () => {} });
  const tool = bridge.tools.find(t => t.name === "tcr_get")!;
  const result = await tool.execute({ record_handle: handle, mode: "owner_selected_source" }, context());
  expect(result.dataClass).toBe("owner_selected_source"); expect((result.value as any).text).toBe("SYNTHETIC_BODY_A");
  await expect(tool.execute({ record_handle: f.snapshot.record_refs[1]!.handle, mode: "owner_selected_source" }, context("other"))).rejects.toThrow("ptc_source_not_admitted");
});
test("context view calls the helper, retains pairs and hides path-bearing pair IDs", async () => {
  const s = setup(), handles = s.snapshot.record_refs.map(ref => ref.handle);
  const result = await s.call("tcr_context_pack", { record_handles: [...handles].reverse(), max_chars: 1000 });
  expect(s.helper.calls()).toBe(1); expect(result.dataClass).toBe("metadata_only");
  expect((result.value as any).records.map((r: any) => r.record_handle)).toEqual(handles);
  expect((result.value as any).decisions[0]).toMatchObject({ action: "keep", record_handles: handles });
  expect((result.value as any).decisions[0].pair_handle).toMatch(/^pair:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("file:"); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_BODY");
});
test("receipt persistence finishes before output release and failure blocks release", async () => {
  let release!: () => void; const latch = new Promise<void>(resolve => { release = resolve; }); let entered = false, completed = false;
  const s = setup({ onReceipt: async () => { entered = true; await latch; } });
  const pending = Promise.resolve(s.call("tcr_query", {})).then(() => { completed = true; });
  await Bun.sleep(1); expect(entered).toBe(true); expect(completed).toBe(false); release(); await pending;
  const other = setup({ onReceipt: () => { throw new Error("private storage error"); } });
  await expect(other.call("tcr_query", {})).rejects.toThrow("ptc_receipt_persistence_failed");
});
test("duplicate calls, cancellation and shared worker budgets block before helper dispatch", async () => {
  const budget = createPtcBudget({ maxCalls: 1 }); const first = setup({ budget }), second = setup({ budget });
  await first.call("tcr_query", {});
  await expect(first.call("tcr_query", {})).rejects.toThrow("ptc_duplicate_call");
  await expect(second.call("tcr_query", {}, context("another-worker"))).rejects.toThrow("ptc_budget_exhausted");
  expect(second.helper.calls()).toBe(0);
  const abort = new AbortController(); abort.abort(); const third = setup();
  await expect(third.call("tcr_query", {}, context("cancelled", abort.signal))).rejects.toThrow("ptc_cancelled"); expect(third.helper.calls()).toBe(0);
});
test("lease revocation after helper output prevents release and retains failed receipt", async () => {
  let checks = 0; const s = setup({ assertActive: () => { if (++checks > 1) fail("lease_lost"); } });
  await expect(s.call("tcr_query", {})).rejects.toThrow("lease_lost"); expect(s.stored[0]!.status).toBe("failed");
  expect(s.stored[0]!.result).toBeNull(); expect(s.stored[0]!.helper).not.toBeNull();
});
test("bounded output and source read reservations fail without releasing partial results", async () => {
  const f = setup({ budget: createPtcBudget({ maxReadBytes: 1 }) });
  await expect(f.call("tcr_get", { record_handle: f.snapshot.record_refs[0]!.handle })).rejects.toThrow("ptc_budget_exhausted"); expect(f.helper.calls()).toBe(0);
  const s = setup({ budget: createPtcBudget({ maxOutputBytes: 512 }) });
  await expect(s.call("tcr_get", { record_handle: s.snapshot.record_refs[0]!.handle })).rejects.toThrow("ptc_json_budget"); expect(s.stored[0]!.result).toBeNull();
});
test("no score tool exists by default; admitted precomputed zero stays measured zero", async () => {
  expect(setup().bridge.tools.some(t => t.name === "tcr_score_prepared")).toBe(false);
  const p = packetFixture(), s = setup({ policy: { native_content: "metadata", prepared_packets: [p.packet] } });
  const result = await s.call("tcr_score_prepared", { packet_handle: p.packet.packet_handle });
  expect((result.value as any).scores[0].keep_call).toBe(0); expect((result.value as any).scoring_mode).toBe("precomputed");
  expect(s.bridge.budget.status().external_calls).toBe(0); expect(JSON.stringify(result)).not.toContain("file:");
  await expect(s.call("tcr_score_prepared", { packet_handle: p.packet.packet_handle, state: "model-supplied RAW" }, context("unsafe"))).rejects.toBeDefined();
});
test("invalid/missing scoring values are errors rather than zero and cannot claim another packet", async () => {
  for (const mutation of [(p: any) => { p.result.scores["file:///synthetic-private/pair"].keepCall = false; },
    (p: any) => { delete p.result.scores["file:///synthetic-private/pair"].keepResult; },
    (p: any) => { p.result.evidence.packet_sha256 = "a".repeat(64); }]) {
    const p = packetFixture(); mutation(p); const s = setup({ policy: { native_content: "metadata", prepared_packets: [p.packet] } });
    await expect(s.call("tcr_score_prepared", { packet_handle: p.packet.packet_handle })).rejects.toBeDefined();
  }
});
test("pure packet admission validates routing, digest, question/pair mapping and selected config", () => {
  const p = packetFixture(), selection = configTemplate().scoring;
  expect(validatePreparedPacketAdmission(p.packet, selection).packet_sha256).toBe(p.prepared.packet_sha256);
  for (const mutate of [(x: any) => { x.prepared.request.provider.allow_fallbacks = true; },
    (x: any) => { x.prepared.request_bytes = 0; }, (x: any) => { x.prepared.pair_map["file:///synthetic-private/pair"].keepResult = "call"; },
    (x: any) => { x.attempt_budget = 1; }, (x: any) => { x.prepared.data_class = "owner_selected_source"; }]) {
    const value = structuredClone(p.packet); mutate(value); expect(() => validatePreparedPacketAdmission(value, selection)).toThrow();
  }
  expect(() => validatePreparedPacketAdmission(p.packet, configTemplate("typesafe").scoring)).toThrow();
});
test("fresh scoring reserves one global attempt before dispatch and consumes unknown outcomes", async () => {
  const p = packetFixture(); const { result: _result, ...fresh } = p.packet; const packet = { ...fresh, attempt_budget: 1 as const };
  let attempts = 0; const scoring = { selection: configTemplate().scoring, configSha256: sha("synthetic-config"), run: async () => { attempts++; fail("provider_http_error"); } };
  expect(() => setup({ policy: { native_content: "metadata", prepared_packets: [packet] }, scoring })).toThrow("ptc_packet_execution_not_admitted");
  const s = setup({ policy: { native_content: "metadata", prepared_packets: [packet] }, scoring, budget: createPtcBudget({ maxExternalCalls: 1 }) });
  await expect(s.call("tcr_score_prepared", { packet_handle: packet.packet_handle })).rejects.toThrow("provider_http_error");
  await expect(s.call("tcr_score_prepared", { packet_handle: packet.packet_handle }, context("retry"))).rejects.toThrow("ptc_packet_attempt_consumed");
  expect(attempts).toBe(1); expect(s.bridge.budget.status().external_calls).toBe(1); expect(s.stored[0]!.external_attempt_reserved).toBe(true);
});
test("CLI scorer validates missing selected key/config/command before any subprocess", () => {
  const w = workspace(), config = configTemplate(); config.recorder.helper_command = ["synthetic-no-such-helper"];
  const base = { command: config.recorder.helper_command, workDir: w.work, config, configSha256: sha(canonical(config)) };
  for (const credential of [{ envName: config.scoring.api_key_env, value: "" }, { envName: "OTHER_KEY", value: "synthetic-key" }]) {
    expect(() => createCliPtcScorer({ ...base, credential })).toThrow("ptc_scoring_credential_unavailable");
  }
  expect(() => createCliPtcScorer({ ...base, configSha256: "a".repeat(64), credential: { envName: config.scoring.api_key_env, value: "synthetic-key" } })).toThrow("ptc_scoring_config_digest_mismatch");
  for (const envName of ["HOME", "BUN_OPTIONS", "NODE_OPTIONS", "LD_PRELOAD", "HTTP_PROXY"]) {
    const unsafe = structuredClone(config); unsafe.scoring.api_key_env = envName;
    expect(() => createCliPtcScorer({ ...base, config: unsafe, configSha256: sha(canonical(unsafe)), credential: { envName, value: "synthetic-key" } })).toThrow();
  }
});
test("scoring CLI sends one selected synthetic key only in child environment and removes key-free temp inputs", async () => {
  const w = workspace(), entry = join(w.root, "synthetic-scorer.mjs"), p = packetFixture();
  writeFileSync(entry, `import fs from 'node:fs';
const args=process.argv.slice(2), value=name=>args[args.indexOf(name)+1];
if(args[0]!=='score-prepared')process.exit(2);
const packet=JSON.parse(fs.readFileSync(value('--input'),'utf8'));
const cfg=fs.readFileSync(value('--config'),'utf8');
if(process.env.OPENROUTER_API_KEY!=='synthetic-test-key'||process.env.TYPESAFE_API_KEY!==undefined||cfg.includes('synthetic-test-key')||args.some(x=>x.includes('synthetic-test-key')))process.exit(3);
const result=${JSON.stringify(p.result)};
if(packet.packet_sha256!==result.evidence.packet_sha256)process.exit(4);
console.log(JSON.stringify(result));\n`, { mode: 0o600 });
  const config = configTemplate(); config.recorder.helper_command = [process.execPath, "--no-env-file", entry];
  const scorer = createCliPtcScorer({ command: config.recorder.helper_command, workDir: w.work, config,
    configSha256: sha(canonical(config)), credential: { envName: config.scoring.api_key_env, value: "synthetic-test-key" } });
  const result = await scorer.run(p.prepared, config.scoring, new AbortController().signal);
  expect(result).toEqual(p.result); expect(JSON.stringify(result)).not.toContain("synthetic-test-key"); expect(readdirSync(w.work)).toEqual([]);
  await expect(scorer.run(p.prepared, config.scoring, new AbortController().signal)).rejects.toThrow("ptc_scorer_attempt_consumed");
  scorer.selection.model = "changed-by-caller" as any;
  await expect(scorer.run(p.prepared, scorer.selection, new AbortController().signal)).rejects.toThrow("ptc_scoring_selection_mismatch");
  expect(readdirSync(w.work)).toEqual([]);
});

const helperEntry = process.env.TCR_HELPER_ENTRYPOINT;
test.skipIf(!helperEntry)("actual configured helper PTC query/get/context-pack uses pinned source bytes and returns no bodies", async () => {
  const w = workspace(), source = join(w.sources, "selected.jsonl");
  writeFileSync(source, [{ type: "session_meta", payload: { id: "synthetic-session" } }, { type: "turn_context", payload: { turn_id: "synthetic-turn" } },
    { type: "response_item", payload: { type: "function_call", call_id: "pair", name: "synthetic", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "pair", output: "SYNTHETIC_RAW_CONTENT" } }].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const command = [process.env.TCR_HELPER_RUNTIME ?? "node", helperEntry!];
  const page = await runHelper([...command, "ingest", "--input", source, "--format", "codex", "--allow-root", w.sources, "--max-bytes", "65536", "--json"], workerOptions({ helper: command })) as any;
  const snapshot = snapshotFor(w.sources, source, page.records);
  const bridge = createPtcTools({ activationId: "synthetic-activation", snapshot, helper: createCliPtcHelper({ command, workDir: w.work }), assertActive: () => {}, onReceipt: () => {} });
  const query = await bridge.tools.find(t => t.name === "tcr_query")!.execute({ fields: ["kind", "native.session_id"] }, context("query"));
  const handles = (query.value as any).records.map((r: any) => r.record_handle); expect(handles).toHaveLength(4);
  const get = await bridge.tools.find(t => t.name === "tcr_get")!.execute({ record_handle: handles[3] }, context("get"));
  expect((get.value as any).source_verified).toBe(true);
  const pack = await bridge.tools.find(t => t.name === "tcr_context_pack")!.execute({ record_handles: handles }, context("pack"));
  expect((pack.value as any).pairs_complete).toBe(true); expect((pack.value as any).records).toHaveLength(4);
  expect(JSON.stringify([query, get, pack])).not.toContain(source); expect(JSON.stringify([query, get, pack])).not.toContain("SYNTHETIC_RAW_CONTENT");
  expect(bridge.receipts().every(receipt => receipt.helper?.execution.transport === "bounded_helper_subprocess")).toBe(true);
});

import { validateApiKeyEnvName, type PortableConfig } from "./config.ts";
import type { PreparedFragment, PreparedPacket, SupervisorContentPolicy, SupervisorPolicy } from "./supervisor-types.ts";
import { absolute, bool, canonical, digest, fail, integer, keys, object, oneOf, sha, str } from "./security.ts";
import { validatePreparedPacketAdmission } from "./ptc-tools.ts";

export interface AgentActivationInput {
  activation_id: string;
  binding_id: string;
  policy: SupervisorPolicy;
  runtime_config: Record<string, unknown>;
  include_existing_windows: boolean;
}
export interface AgentScoringCredential { envName: string; value: string }

/** Explicit host-only extraction. Default-disabled scoring does not inspect an environment value. */
export function selectAgentScoringCredential(config: PortableConfig, policy: SupervisorPolicy,
  environment: NodeJS.ProcessEnv): AgentScoringCredential | undefined {
  if (policy.external_score_max_calls === 0) return undefined;
  if (policy.external_score_max_calls !== 1 || !policy.content.prepared_packets.some(p => p.attempt_budget === 1)) fail("agent_external_scoring_not_admitted");
  const name = validateApiKeyEnvName(config.scoring.api_key_env);
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) fail("agent_provider_key_missing");
  if (value.length > 8192 || !/^[\x21-\x7e]+$/u.test(value)) fail("agent_provider_key_invalid");
  return { envName: name, value };
}

/** Turn an explicit owner admission into bounded immutable service policy. No I/O or model calls. */
export function materializeAgentActivation(config: PortableConfig, value: unknown, state: string): AgentActivationInput {
  const input = object(value);
  keys(input, ["schema_version", "activation_id", "binding_id", "daemon_id", "objective", "include_existing_windows", "model_profile",
    "prepared_fragments", "prepared_packets", "selected_record_handles", "stop"]);
  if (input.schema_version !== "task-checkpoint-record.agent-activation.v1") fail("agent_activation_version_unsupported");
  const objective = input.objective === undefined ? "Observe the activated task window and produce evidence-linked continuity guidance." : input.objective;
  if (typeof objective !== "string" || !objective.trim() || Buffer.byteLength(objective) > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(objective)) fail("agent_objective_invalid");
  const cfg = config.agent_service;
  if (!cfg) fail("agent_service_config_required");
  if (!config.codex.home || (cfg.runtime_update.mode === "pinned" && !config.codex.executable)) fail("agent_codex_paths_required");
  const array = (raw: unknown, cap: number): unknown[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > cap) fail("agent_admission_array_budget");
    return raw;
  };
  const fragments: PreparedFragment[] = array(input.prepared_fragments, 64).map(raw => {
    const f = object(raw); keys(f, ["fragment_handle", "record_handle", "data_class", "text", "sha256", "admission_ref"]);
    if (typeof f.text !== "string" || Buffer.byteLength(f.text) > 32768) fail("agent_fragment_text_budget");
    const fragment: PreparedFragment = { fragment_handle: str(f.fragment_handle, 128), record_handle: str(f.record_handle, 128),
      data_class: oneOf(f.data_class, ["synthetic", "redacted"] as const), text: f.text, sha256: digest(f.sha256), admission_ref: str(f.admission_ref, 512) };
    if (sha(fragment.text) !== fragment.sha256) fail("agent_fragment_digest_mismatch");
    return fragment;
  });
  if (fragments.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0) > 65536) fail("agent_fragment_total_budget");
  if (new Set(fragments.map(f => f.fragment_handle)).size !== fragments.length) fail("agent_duplicate_fragment_handle");
  if (cfg.data_policy === "metadata_only" && fragments.length) fail("agent_prepared_fragments_not_enabled");
  const packets: PreparedPacket[] = array(input.prepared_packets, 1).map(raw => {
    const packet = validatePreparedPacketAdmission(raw, config.scoring);
    return { ...packet, prepared: object(packet.prepared) };
  });
  if (new Set(packets.map(p => p.packet_handle)).size !== packets.length) fail("agent_duplicate_packet_handle");
  const freshAttempts = packets.reduce((sum, packet) => sum + packet.attempt_budget, 0);
  if (cfg.external_score_max_calls > 0 && freshAttempts === 0) fail("agent_prepared_packet_required");
  if (cfg.external_score_max_calls === 0 && freshAttempts > 0) fail("agent_fresh_packet_requires_budget");
  const selected = array(input.selected_record_handles, 128).map(item => str(item, 128));
  if (selected.length) fail("agent_selected_source_policy_unsupported");
  const content: SupervisorContentPolicy = { native_content: cfg.data_policy === "metadata_only" ? "metadata" : "prepared_fragments",
    prepared_fragments: fragments, prepared_packets: packets, selected_record_handles: selected };
  const stop = input.stop === undefined ? {} : object(input.stop); keys(stop, ["mode", "max_age_ms"]);
  const mode = stop.mode === undefined ? "advisory" : oneOf(stop.mode, ["advisory", "strict_once"] as const);
  const modelProfile = input.model_profile === undefined ? "production" : oneOf(input.model_profile, ["production", "eval"] as const);
  const runtime: PortableConfig = { ...config, recorder: { ...config.recorder, state_dir: absolute(state) } };
  const outputBytes = 1024 * 1024;
  const policy: SupervisorPolicy = {
    schema_version: "task-checkpoint-record.supervisor-policy.v1", daemon_id: str(input.daemon_id, 128), objective,
    config_sha256: sha(canonical(runtime)), supervisor: { ...(modelProfile === "eval" ? config.codex.eval : config.codex.supervisor) },
    worker: { ...(modelProfile === "eval" ? config.codex.eval : config.codex.semantic_worker) },
    worker_concurrency: cfg.concurrency, max_workers: cfg.max_workers, native_call_budget: cfg.max_native_turns,
    tool_call_budget: cfg.max_tool_calls, tool_output_bytes: outputBytes, max_rounds: cfg.max_rounds,
    total_native_calls: cfg.max_rounds * cfg.max_native_turns, total_tool_calls: cfg.max_rounds * cfg.max_tool_calls,
    total_tool_output_bytes: cfg.max_rounds * outputBytes, external_score_max_calls: cfg.external_score_max_calls,
    total_external_score_calls: Math.min(cfg.max_rounds * cfg.external_score_max_calls, freshAttempts),
    round_timeout_ms: cfg.deadline_ms, lease_ms: 30000, max_attempts: 3, content,
    stop: { mode, max_age_ms: stop.max_age_ms === undefined ? 300000 : integer(stop.max_age_ms, 1000, 300000) },
  };
  // Copy nested input objects so subsequent caller edits cannot alter the candidate.
  return JSON.parse(canonical({ activation_id: str(input.activation_id, 128), binding_id: str(input.binding_id, 128), policy,
    runtime_config: runtime, include_existing_windows: input.include_existing_windows === undefined ? false : bool(input.include_existing_windows) })) as AgentActivationInput;
}

export function agentActivationSchema(): object {
  const identity = { type: "string", minLength: 1, maxLength: 128 };
  const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
  return { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Explicit native agent activation admission v1",
    type: "object", additionalProperties: false, required: ["schema_version", "activation_id", "binding_id", "daemon_id"], properties: {
      schema_version: { const: "task-checkpoint-record.agent-activation.v1" }, activation_id: identity, binding_id: identity, daemon_id: identity,
      objective: { type: "string", minLength: 1, maxLength: 4096, description: "Host task objective; at most 4096 UTF-8 bytes. It cannot extend host tool, source, credential or scoring authority." },
      include_existing_windows: { type: "boolean", default: false }, model_profile: { enum: ["production", "eval"], default: "production" },
      selected_record_handles: { type: "array", maxItems: 0, description: "Reserved and empty in metadata/prepared-fragment policy; owner-selected RAW transport is unsupported." },
      prepared_fragments: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
        required: ["fragment_handle", "record_handle", "data_class", "text", "sha256", "admission_ref"], properties: {
          fragment_handle: identity, record_handle: identity, data_class: { enum: ["synthetic", "redacted"] },
          text: { type: "string", maxLength: 32768 }, sha256: hash, admission_ref: { type: "string", minLength: 1, maxLength: 512 } } } },
      prepared_packets: { type: "array", maxItems: 1, items: { type: "object", additionalProperties: false,
        required: ["packet_handle", "packet_sha256", "prepared", "admission_ref", "attempt_budget"], properties: {
          packet_handle: identity, packet_sha256: hash, prepared: { type: "object" }, admission_ref: { type: "string", minLength: 1, maxLength: 512 }, attempt_budget: { enum: [0, 1] }, result: {} } } },
      stop: { type: "object", additionalProperties: false, properties: { mode: { enum: ["advisory", "strict_once"] },
        max_age_ms: { type: "integer", minimum: 1000, maximum: 300000 } } },
    }, description: "Host-supplied admission only. Text labels are assertions by the preparer, never proof of sanitization. Existing windows require explicit opt-in; daemon/model start is separate." };
}

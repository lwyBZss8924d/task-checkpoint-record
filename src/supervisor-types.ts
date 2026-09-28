import type { Binding, NormalizedRecord, Source } from "./types.ts";

export interface SupervisorSnapshot {
  schema_version: "task-checkpoint-record.supervisor-snapshot.v1";
  snapshot_sha256: string;
  store_id: string;
  binding_id: string;
  task_id: string;
  window_id: string;
  window_sha256: string;
  binding_sha256: string;
  created_at: string;
  task_native: { client: Binding["client"]; profile: string; session_id: string; hook_turn_id: string | null };
  source_root: string;
  sources: Source[];
  record_refs: { handle: string; record_id: string; sha256: string; metadata: NormalizedRecord }[];
  page_refs: { page_id: string; sha256: string; metadata: Record<string, unknown> }[];
  coverage: { kind: "metadata_only"; selected_records: number; total_records: number; truncated: boolean; omissions: string[] };
}

export interface PreparedFragment {
  fragment_handle: string;
  record_handle: string;
  data_class: "synthetic" | "redacted";
  text: string;
  sha256: string;
  admission_ref: string;
}
export interface PreparedPacket {
  packet_handle: string;
  packet_sha256: string;
  prepared: Record<string, unknown>;
  admission_ref: string;
  attempt_budget: 0 | 1;
  result?: unknown;
}
export interface SupervisorContentPolicy {
  native_content: "metadata" | "prepared_fragments";
  prepared_fragments: PreparedFragment[];
  selected_record_handles: string[];
  prepared_packets: PreparedPacket[];
}
export interface SupervisorPolicy {
  schema_version: "task-checkpoint-record.supervisor-policy.v1";
  daemon_id: string;
  config_sha256: string;
  objective: string;
  supervisor: { model: "gpt-6-sol" | "gpt-6-luna"; effort: "medium" | "high" };
  worker: { model: "gpt-6-sol" | "gpt-6-luna"; effort: "medium" | "high" };
  worker_concurrency: number;
  max_workers: number;
  native_call_budget: number;
  tool_call_budget: number;
  tool_output_bytes: number;
  max_rounds: number;
  total_native_calls: number;
  total_tool_calls: number;
  total_tool_output_bytes: number;
  external_score_max_calls: number;
  total_external_score_calls: number;
  round_timeout_ms: number;
  lease_ms: number;
  max_attempts: number;
  content: SupervisorContentPolicy;
  stop: { mode: "advisory" | "strict_once"; max_age_ms: number };
}
export interface SupervisorActivation {
  activation_id: string;
  binding_id: string;
  task_id: string;
  daemon_id: string;
  policy_sha256: string;
  policy: SupervisorPolicy;
  runtime_config: Record<string, unknown>;
  created_at: number;
  start_after_window_rowid: number;
  active: boolean;
}
export interface SupervisorRun {
  run_id: string;
  activation_id: string;
  window_id: string;
  snapshot_sha256: string;
  policy_sha256: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  phase: string;
  lease_token: string | null;
  lease_until: number | null;
  generation: number;
  attempts: number;
  model_started: number;
  cancel_requested: number;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
}
export interface WorkerTaskSpec {
  task_key: string;
  objective: string;
  record_handles?: string[];
}
export interface WorkerReport {
  task_key: string;
  summary: string;
  claims: { claim_id: string; statement: string; evidence_refs: string[] }[];
  omissions: string[];
}
export interface SupervisorReduction {
  summary: string;
  continuity_context: string;
  findings: { category: "progress" | "risk" | "unknown"; statement: string; evidence_refs: string[] }[];
  next_actions: { action_id: string; reason: string; evidence_refs: string[] }[];
  recommendation: "continue" | "checkpoint_ready" | "needs_attention" | "insufficient_evidence";
}
export interface AgentNativeReceipt {
  session_id: string | null;
  thread_id: string;
  turn_id: string;
  model: string;
  effort: string;
  role: "supervisor" | "worker";
  runtime_receipt: Record<string, unknown>;
}

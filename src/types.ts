export type Client = "codex" | "claude" | "pi";
export type Format = Client | "atif";
export type Role = "master" | "observer" | "worker";
export interface Source { source_id: string; path: string; format: Format; start_at?: "new" | "beginning" | number }
export interface Binding {
  schema_version: "task-checkpoint-record.binding.v1";
  binding_id: string;
  task_id: string;
  project_id: string | null;
  client: Client;
  profile: string;
  runtime_home: string | null;
  native_session_id: string;
  role: Role;
  source_root: string;
  sources: Source[];
}
export interface Native {
  session_id: string | null; turn_id: string | null; entry_id: string | null;
  parent_entry_id: string | null; trajectory_id: string | null; step_id: number | string | null;
}
export interface NormalizedRecord {
  record_id: string; client: Format; kind: string; timestamp: string | null;
  native: Native;
  source: { uri: string; format: Format; version: string | number | null; offset: number; length: number; sha256: string; json_pointer: string };
  identity_evidence?: Partial<Record<keyof Native, {offset:number;length:number;sha256:string;json_pointer:string}>>;
  logical?: {event_id:string|null;task_id:string|null;run_id:string|null;project_id:string|null};
  relay?: {event_uuid:string|null;parent_scope_uuid:string|null;propagation_root_uuid:string|null;atof_version:string|null;name:string};
  atif?: {session_id:string|null;trajectory_id:string|null;step_id:number|null};
  atif_identity_evidence?: Partial<Record<"session_id"|"trajectory_id"|"step_id",Evidence>>;
  native_actor?: {client:string;session_ref:string;roles:string[];provenance_ref:ArtifactRef};
  native_actor_evidence?: Record<"client"|"session_ref"|"roles"|"provenance_ref",Evidence>;
  labels: string[]; text_available: boolean;
}
export interface Evidence {offset:number;length:number;sha256:string;json_pointer:string}
export interface ArtifactRef {record_id:string;uri:string;json_pointer:string;sha256:string}
export interface TelemetryCorrelation {namespace:"opentelemetry.w3c";source:"explicit_adapter"|"unavailable";trace_id:string|null;span_id:string|null}
export interface Page {
  schema_version: "ultrafast-atif.page.v1"; records: NormalizedRecord[];
  next_offset: number | null; eof: boolean; incomplete_tail: boolean; omissions: string[];
}
export interface HookMetadata {
  hook_event_name: string; native_session_id: string; native_turn_id: string | null;
  transcript_path: string | null; input_sha256: string; delivery_id: string | null;
  telemetry?: TelemetryCorrelation;
}
export interface Job {
  job_id: string; window_id: string; binding_id: string; source_id: string;
  state: string; lease_token: string | null; lease_until: number | null;
  generation: number; attempts: number; error_code: string | null;
  target_size: number; target_dev: number; target_ino: number;
}
export interface Fingerprint { dev: number; ino: number; cursor: number; head: string; tail: string }
export interface SourceState {
  binding_id: string; source_id: string; cursor: number;
  fingerprint: string | null; atif_complete: number;
}
export interface WorkerOptions {
  helper: string[]; concurrency?: number; maxJobs?: number; leaseMs?: number;
  timeoutMs?: number; stdoutBytes?: number; pageBytes?: number; pageLimit?: number;
}
export interface QueryOptions {
  kind: "records" | "events" | "windows" | "checkpoints";
  filters?: Record<string, string>;
  fields?: string[]; limit?: number; offset?: number;
}

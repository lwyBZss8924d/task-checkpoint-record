/** Pi 0.87.1 adapter template. Importing/registering starts no process or service.
 * Source contract: pi coding-agent 6f7551516b84278eb9da1c340c8e7bc66be1a6ba.
 * Configure an explicit bounded local sink; do not place this in a global extension
 * path without an owner-reviewed install. This factory deliberately has no default
 * Pi auto-loader export: a reviewed wrapper calls registerTaskCheckpointRecord.
 */
export type PiEventName = "session_start" | "session_shutdown" | "session_before_compact" | "session_compact" | "turn_end";
export type PiContext = { cwd: string; sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } };
export type PiHookEnvelope = {
  schema_version: "task-checkpoint-record.pi-hook.v1"; hook_event_name: PiEventName;
  session_id: string; cwd: string; transcript_path: string | null;
  adapter: { schema_version: "task-checkpoint-record.pi-adapter.v1"; source_version: "0.87.1";
    reason: string | null; outcome: string | null; message_entry_id: string | null; tool_result_entry_ids: string[];
    native_turn_id: null; persistence: "unverified_callback_metadata" };
};
export type PiRegistrar = { on(event: any, handler: (event: any, ctx: PiContext) => Promise<void>): () => void };
export function registerTaskCheckpointRecord(pi: PiRegistrar, options: {
  role: "master" | "observer" | "worker";
  admit: (envelope: PiHookEnvelope, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  onDrop?: (code: string) => void;
}): () => void {
  // A caller-provided sink must respect abort and invoke the reviewed CLI once;
  // it must never create a daemon/model or put transcript text on the wire.
  if (options.role !== "master") return () => {};
  const deadline = options.timeoutMs ?? 250;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 1000) throw new Error("invalid_admission_deadline");
  const off: (() => void)[] = []; let disposed = false;
  const dropped = (code: string) => { try { options.onDrop?.(code); } catch { /* reporting cannot control Pi */ } };
  const scalar = (v: unknown) => typeof v === "string" && v.length <= 4096 && !/[\x00-\x1f]/.test(v) ? v : null;
  for (const name of ["session_start", "session_shutdown", "session_before_compact", "session_compact", "turn_end"] as const) {
    off.push(pi.on(name, async (event, ctx) => {
      if (disposed) return;
      const session = scalar(ctx.sessionManager.getSessionId()); if (!session) { dropped("session_unavailable"); return; }
      const envelope: PiHookEnvelope = {
        schema_version: "task-checkpoint-record.pi-hook.v1", hook_event_name: name, session_id: session,
        cwd: ctx.cwd, transcript_path: scalar(ctx.sessionManager.getSessionFile()),
        adapter: { schema_version: "task-checkpoint-record.pi-adapter.v1", source_version: "0.87.1",
          reason: scalar(event.reason), outcome: scalar(event.outcome), message_entry_id: scalar(event.messageEntryId),
          tool_result_entry_ids: Array.isArray(event.toolResultEntryIds) ? event.toolResultEntryIds.slice(0, 64).map(scalar).filter((s: any): s is string => s !== null) : [],
          native_turn_id: null, persistence: "unverified_callback_metadata" }
      };
      const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("admission_timeout")); }, deadline); });
        await Promise.race([Promise.resolve().then(() => options.admit(envelope, abort.signal)), expired]);
      } catch { dropped(abort.signal.aborted ? "admission_timeout" : "admission_failed"); }
      finally { clearTimeout(timer); }
      // Return void: no cancel/continue/block signal, no model-visible context,
      // no appendEntry and no assertion that getSessionFile has reached disk.
    }));
  }
  return () => { if (disposed) return; disposed = true; for (const remove of off) remove(); };
}

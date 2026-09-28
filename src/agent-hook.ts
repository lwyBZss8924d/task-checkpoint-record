import type { HookResult } from "./hooks.ts";
import type { Store } from "./store.ts";
import { SupervisorStore } from "./supervisor-store.ts";
import { safeError } from "./security.ts";

/** After durable ingress: enqueue an activated observer wake and inspect only an already cached review. */
export function agentHookOutput(store: Store, result: HookResult, client: string, input: unknown): Record<string, unknown> {
  if (!result.window_id) return result.output;
  try {
    const agents = new SupervisorStore(store);
    if (!agents.initialized()) return result.output;
    const window = store.db.query("SELECT binding_id,hook_turn_id FROM windows WHERE window_id=?").get(result.window_id) as { binding_id: string; hook_turn_id: string | null } | null;
    if (!window) return result.output;
    agents.wake(window.binding_id, result.window_id);
    const event = input && typeof input === "object" && "hook_event_name" in input ? input.hook_event_name : null;
    if (client === "codex" && event === "Stop") {
      const cached = agents.cachedReview({ binding_id: window.binding_id, turn_id: window.hook_turn_id,
        window_id: result.window_id, consume_strict: true });
      if (cached.decision === "block_once" && typeof cached.reason === "string")
        return { decision: "block", reason: cached.reason };
    }
    return result.output;
  } catch (error) {
    // A semantic-side error cannot roll back, replace or misreport durable ingress.
    process.stderr.write(JSON.stringify({ schema_version: "task-checkpoint-record.agent-hook-diagnostic.v1", error: safeError(error), model_waited: false }) + "\n");
    return result.output;
  }
}

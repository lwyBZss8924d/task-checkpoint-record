import { canonical, digest, fail, object, oneOf, sha, str, telemetryCorrelation } from "./security.ts";
import { Store } from "./store.ts";
import type { Client, HookMetadata } from "./types.ts";

const EVENTS: Record<Client, readonly string[]> = {
  codex: ["SessionStart","UserPromptSubmit","PreCompact","PostCompact","Interrupt","SessionEnd","Stop"],
  claude: ["SessionStart","UserPromptSubmit","PreCompact","PostCompact","SessionEnd","Stop"],
  pi: ["session_start","session_shutdown","session_before_compact","session_compact","turn_end"]
};
export interface HookResult {
  output: Record<string, unknown>;
  disposition: string;
  event_id?: string;
  window_id?: string;
}
export function handleHook(store: Store, clientInput: unknown, profileInput: unknown, input: unknown, envRole?: string): HookResult {
  const client = oneOf(clientInput,["codex","claude","pi"] as const); const profile=str(profileInput);
  const p=object(input);
  if(envRole && envRole!=="master") {store.count("suppressed_role");return {output:{},disposition:"suppressed_role"};}
  if(p.agent_id!==undefined&&p.agent_id!==null&&p.agent_id!=="") {store.count("suppressed_subagent");return {output:{},disposition:"suppressed_subagent"};}
  if(p.stop_hook_active===true || p.task_checkpoint_record_observer===true){store.count("suppressed_recursion");return {output:{},disposition:"suppressed_recursion"};}
  const event=oneOf(p.hook_event_name,EVENTS[client]);
  if(client==="pi" && p.schema_version!=="task-checkpoint-record.pi-hook.v1")fail("pi_adapter_envelope_required");
  const sessionId=str(p.session_id);
  const binding=store.activeBinding(client,profile,sessionId);
  if(!binding||binding.role!=="master"){store.count("unbound_hook");return {output:{},disposition:"unbound"};}
  // SessionStart/SessionEnd do not carry a native Codex turn. Claude prompt_id
  // and Pi turnIndex are separate identities and never stand in for turn_id.
  const hasNativeTurn=client==="codex" && !["SessionStart","SessionEnd"].includes(event);
  const turnId=hasNativeTurn && p.turn_id!==undefined && p.turn_id!==null ? str(p.turn_id):null;
  const transcript=p.transcript_path==null?null:str(p.transcript_path,4096);
  if(transcript && !binding.sources.some(s=>s.path===transcript))fail("hook_source_mismatch");
  const metadata: HookMetadata={hook_event_name:event,native_session_id:sessionId,native_turn_id:turnId,
    transcript_path:transcript,input_sha256:sha(canonical(p)),delivery_id:null,
    telemetry:telemetryCorrelation(p.task_checkpoint_record_telemetry)};
  // Callback metadata retains only selected fields and a digest, never prompts.
  digest(metadata.input_sha256);
  const queued=store.enqueue(binding,metadata);
  let output:Record<string,unknown>={};
  if(["SessionStart","UserPromptSubmit"].includes(event) && client!=="pi"){
    const recall=store.cachedRecall(binding.binding_id);
    const text="Local task checkpoint metadata (cached; no acceptance verdict): "+JSON.stringify(recall);
    if(Buffer.byteLength(text)<=4096)output={hookSpecificOutput:{hookEventName:event,additionalContext:text}};
  } else if(event==="PostCompact" || event==="session_compact" || event==="Stop"){
    // Native PostCompact has no supported additionalContext contract. Cache is
    // available through `recall`; Stop is advisory and never blocks here.
    store.cachedRecall(binding.binding_id);
  }
  return {output,disposition:queued.duplicate?"duplicate":"enqueued",event_id:queued.event_id,window_id:queued.window_id};
}

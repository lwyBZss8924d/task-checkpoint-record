import { canonical, digest, fail, integer, keys, object, oneOf, sha, str } from "./security.ts";
import type { SupervisorContentPolicy, SupervisorPolicy } from "./supervisor-types.ts";
import { validatePreparedPacketAdmission } from "./ptc-tools.ts";

export function createSupervisorPolicy(input: Partial<SupervisorPolicy> & Pick<SupervisorPolicy,"daemon_id"|"config_sha256">): SupervisorPolicy {
  const max_workers=input.max_workers??2, max_rounds=input.max_rounds??2;
  const native_call_budget=input.native_call_budget??3, tool_call_budget=input.tool_call_budget??64;
  const tool_output_bytes=input.tool_output_bytes??1024*1024;
  const {daemon_id,config_sha256,...overrides}=input;
  return validateSupervisorPolicy({
    schema_version:"task-checkpoint-record.supervisor-policy.v1",daemon_id,config_sha256,objective:"Observe the activated task window and produce evidence-linked continuity guidance.",
    supervisor:{model:"gpt-6-sol",effort:"medium"},worker:{model:"gpt-6-luna",effort:"medium"},
    worker_concurrency:2,max_workers,native_call_budget,tool_call_budget,tool_output_bytes,
    max_rounds,total_native_calls:max_rounds*native_call_budget,total_tool_calls:max_rounds*tool_call_budget,
    total_tool_output_bytes:max_rounds*tool_output_bytes,external_score_max_calls:0,total_external_score_calls:0,round_timeout_ms:180000,lease_ms:30000,max_attempts:3,
    content:{native_content:"metadata",prepared_fragments:[],selected_record_handles:[],prepared_packets:[]},
    stop:{mode:"advisory",max_age_ms:60000},...overrides
  });
}
export function validateSupervisorPolicy(value:unknown):SupervisorPolicy {
  const p=object(value);
  keys(p,["schema_version","daemon_id","config_sha256","objective","supervisor","worker","worker_concurrency","max_workers","native_call_budget","tool_call_budget","tool_output_bytes","max_rounds","total_native_calls","total_tool_calls","total_tool_output_bytes","external_score_max_calls","total_external_score_calls","round_timeout_ms","lease_ms","max_attempts","content","stop"]);
  if(p.schema_version!=="task-checkpoint-record.supervisor-policy.v1")fail("supervisor_policy_version");
  const selection=(value:unknown)=>{const s=object(value);keys(s,["model","effort"]);return{model:oneOf(s.model,["gpt-6-sol","gpt-6-luna"] as const),effort:oneOf(s.effort,["medium","high"] as const)};};
  const c=object(p.content);keys(c,["native_content","prepared_fragments","selected_record_handles","prepared_packets"]);
  const mode=oneOf(c.native_content,["metadata","prepared_fragments"] as const);
  if(!Array.isArray(c.prepared_fragments)||c.prepared_fragments.length>1000||!Array.isArray(c.selected_record_handles)||c.selected_record_handles.length!==0||!Array.isArray(c.prepared_packets)||c.prepared_packets.length>1)fail("invalid_supervisor_content");
  const content:SupervisorContentPolicy={native_content:mode,selected_record_handles:[],prepared_fragments:c.prepared_fragments.map((v:unknown)=>{
    const f=object(v);keys(f,["fragment_handle","record_handle","data_class","text","sha256","admission_ref"]);
    if(typeof f.text!=="string"||Buffer.byteLength(f.text)>64*1024||sha(f.text)!==digest(f.sha256))fail("invalid_prepared_fragment");
    return{fragment_handle:str(f.fragment_handle),record_handle:str(f.record_handle),data_class:oneOf(f.data_class,["synthetic","redacted"] as const),text:f.text,sha256:f.sha256,admission_ref:str(f.admission_ref)};
  }),prepared_packets:c.prepared_packets.map((v:unknown)=>{const admitted=validatePreparedPacketAdmission(v);return{...admitted,prepared:object(admitted.prepared)};})};
  if(mode==="metadata"&&content.prepared_fragments.length)fail("prepared_content_requires_explicit_policy");
  for(const list of [content.prepared_fragments.map(f=>f.fragment_handle),content.prepared_packets.map(p=>p.packet_handle)])if(new Set(list).size!==list.length)fail("duplicate_prepared_handle");
  if(Buffer.byteLength(canonical(content))>4*1024*1024)fail("supervisor_content_budget");
  const stop=object(p.stop);keys(stop,["mode","max_age_ms"]);
  if(typeof p.objective!=="string"||!p.objective.trim()||Buffer.byteLength(p.objective)>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(p.objective))fail("invalid_supervisor_objective");
  const result:SupervisorPolicy={schema_version:p.schema_version,daemon_id:str(p.daemon_id),config_sha256:digest(p.config_sha256),objective:p.objective,supervisor:selection(p.supervisor),worker:selection(p.worker),
    worker_concurrency:integer(p.worker_concurrency,1,32),max_workers:integer(p.max_workers,1,32),native_call_budget:integer(p.native_call_budget,2,33),
    tool_call_budget:integer(p.tool_call_budget,1,256),tool_output_bytes:integer(p.tool_output_bytes,1024,8*1024*1024),max_rounds:integer(p.max_rounds,1,32),
    total_native_calls:integer(p.total_native_calls,2,1056),total_tool_calls:integer(p.total_tool_calls,1,8192),total_tool_output_bytes:integer(p.total_tool_output_bytes,1024,256*1024*1024),
    external_score_max_calls:integer(p.external_score_max_calls,0,1),total_external_score_calls:integer(p.total_external_score_calls,0,32),
    round_timeout_ms:integer(p.round_timeout_ms,1000,300000),lease_ms:integer(p.lease_ms,1000,60000),max_attempts:integer(p.max_attempts,1,3),content,
    stop:{mode:oneOf(stop.mode,["advisory","strict_once"] as const),max_age_ms:integer(stop.max_age_ms,1000,300000)}};
  if(result.worker_concurrency>result.max_workers||result.max_workers+1>result.native_call_budget||result.total_native_calls<result.native_call_budget||result.total_tool_calls<result.tool_call_budget||result.total_tool_output_bytes<result.tool_output_bytes)fail("inconsistent_supervisor_budgets");
  if(result.total_external_score_calls>result.max_rounds*result.external_score_max_calls||result.total_external_score_calls<result.external_score_max_calls||content.prepared_packets.some(p=>p.attempt_budget===1)&&result.external_score_max_calls!==1)fail("inconsistent_external_score_budget");
  return structuredClone(result);
}

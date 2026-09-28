import { oneOf } from "./security.ts";
import { FILTER_COLUMNS, QUERY_FIELDS } from "./store.ts";
import type { QueryOptions } from "./types.ts";

const text={type:"string",minLength:1,maxLength:512,pattern:"^[^\\u0000-\\u001f\\u007f]+$"};
const path={type:"string",minLength:1,maxLength:4096,pattern:"^/",description:"Canonical absolute local path; runtime additionally rejects symlinks, hardlinks, credentials and source-root escapes."};
const format={enum:["codex","claude","pi","atif"]};
const maybeText={anyOf:[text,{type:"null"}]};
const pointer={type:"string",maxLength:2048,pattern:"^(?:/(?:[^~]|~[01])*)?$"};
const evidence={type:"object",additionalProperties:false,required:["offset","length","sha256","json_pointer"],properties:{offset:{type:"integer",minimum:0},length:{type:"integer",minimum:1,maximum:4*1024*1024},sha256:{type:"string",pattern:"^[a-f0-9]{64}$"},json_pointer:pointer}};
const artifact={type:"object",additionalProperties:false,required:["record_id","uri","json_pointer","sha256"],properties:{record_id:text,uri:{...text,maxLength:2048},json_pointer:pointer,sha256:{type:"string",pattern:"^[a-f0-9]{64}$"}}};
const nativeNames=["session_id","turn_id","entry_id","parent_entry_id","trajectory_id","step_id"];
const binding={
  type:"object",additionalProperties:false,
  required:["schema_version","binding_id","task_id","project_id","client","profile","runtime_home","native_session_id","role","source_root","sources"],
  properties:{schema_version:{const:"task-checkpoint-record.binding.v1"},binding_id:text,task_id:text,project_id:maybeText,client:{enum:["codex","claude","pi"]},profile:text,runtime_home:{anyOf:[path,{type:"null"}]},native_session_id:text,role:{enum:["master","observer","worker"]},source_root:path,
    sources:{type:"array",minItems:1,maxItems:32,items:{type:"object",additionalProperties:false,required:["source_id","path","format"],properties:{source_id:text,path,format,start_at:{anyOf:[{enum:["new","beginning"]},{type:"integer",minimum:0}],default:"new",description:"new captures current complete-record EOF; beginning is explicit historical replay; integer requires a complete-record boundary."}}}}}
};
const record={type:"object",additionalProperties:false,required:["record_id","client","kind","timestamp","native","source","labels","text_available"],properties:{
  record_id:text,client:format,kind:{...text,maxLength:128},timestamp:{anyOf:[{...text,maxLength:128},{type:"null"}]},
  native:{type:"object",additionalProperties:false,required:nativeNames,properties:{session_id:maybeText,turn_id:maybeText,entry_id:maybeText,parent_entry_id:maybeText,trajectory_id:maybeText,step_id:{anyOf:[{type:"integer",minimum:1},{type:"null"}]}}},
  source:{type:"object",additionalProperties:false,required:["uri","format","version","offset","length","sha256","json_pointer"],properties:{...evidence.properties,uri:{type:"string",maxLength:8192,pattern:"^file:///"},format,version:{anyOf:[{...text,maxLength:128},{type:"integer",minimum:0,maximum:1000000},{type:"null"}]}}},
  labels:{type:"array",maxItems:32,items:{...text,maxLength:128}},text_available:{type:"boolean"},
  identity_evidence:{type:"object",additionalProperties:false,properties:Object.fromEntries(nativeNames.map(name=>[name,evidence])),description:"Required by runtime for every non-null native field; pointer scalar, type, slice SHA and range are verified against the explicitly bound file."}
  ,logical:{type:"object",additionalProperties:false,required:["event_id","task_id","run_id","project_id"],properties:Object.fromEntries(["event_id","task_id","run_id","project_id"].map(name=>[name,maybeText]))}
  ,relay:{type:"object",additionalProperties:false,required:["event_uuid","parent_scope_uuid","propagation_root_uuid","atof_version","name"],properties:{...Object.fromEntries(["event_uuid","parent_scope_uuid","propagation_root_uuid","atof_version"].map(name=>[name,maybeText])),name:{...text,maxLength:128}}}
  ,atif:{type:"object",additionalProperties:false,required:["session_id","trajectory_id","step_id"],properties:{session_id:maybeText,trajectory_id:maybeText,step_id:{anyOf:[{type:"integer",minimum:1},{type:"null"}]}}}
  ,atif_identity_evidence:{type:"object",additionalProperties:false,properties:Object.fromEntries(["session_id","trajectory_id","step_id"].map(name=>[name,evidence]))}
  ,native_actor:{type:"object",additionalProperties:false,required:["client","session_ref","roles","provenance_ref"],properties:{client:text,session_ref:text,roles:{type:"array",minItems:1,maxItems:32,items:{...text,maxLength:128},contains:{const:"primary_actor"}},provenance_ref:artifact}}
  ,native_actor_evidence:{type:"object",additionalProperties:false,required:["client","session_ref","roles","provenance_ref"],properties:Object.fromEntries(["client","session_ref","roles","provenance_ref"].map(name=>[name,evidence]))}
}};
const helperPage={type:"object",additionalProperties:false,required:["schema_version","records","next_offset","eof","incomplete_tail","omissions"],properties:{schema_version:{const:"ultrafast-atif.page.v1"},records:{type:"array",maxItems:1000,items:record},next_offset:{anyOf:[{type:"integer",minimum:0},{type:"null"}]},eof:{type:"boolean"},incomplete_tail:{type:"boolean"},omissions:{type:"array",maxItems:128,items:text},source_state:{type:"object",description:"Optional helper diagnostic; never substitutes for independently opened-file verification."}}};
const query={oneOf:(Object.keys(QUERY_FIELDS) as QueryOptions["kind"][]).map(kind=>{
  const filters=[...Object.keys(FILTER_COLUMNS[kind]),...(kind==="records"?["task_id","binding_id","window_id","hook_turn_id"]:[])];
  return{type:"object",additionalProperties:false,required:["kind"],properties:{kind:{const:kind},
    filters:{type:"object",additionalProperties:false,properties:Object.fromEntries(filters.map(key=>[key,text])),description:"Exact AND filters. Window relations must match one window; nulls and SQL operators are rejected."},
    fields:{type:"array",minItems:1,maxItems:24,uniqueItems:true,items:{enum:QUERY_FIELDS[kind]}},
    limit:{type:"integer",minimum:1,maximum:100,default:20},offset:{type:"integer",minimum:0,maximum:10000,default:0}}};
})};
export function schema(name:string):Record<string,unknown>{
  oneOf(name,["binding","query","helper-page"]);
  return {$schema:"https://json-schema.org/draft/2020-12/schema",$id:`urn:task-checkpoint-record:${name}:v1`,title:`task-checkpoint-record ${name}`, ...({binding,query,"helper-page":helperPage}[name])};
}

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, fstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Store } from "./store.ts";
import type { Binding, Evidence, Job, Native, NormalizedRecord, Page, Source, WorkerOptions } from "./types.ts";
import { bool, canonical, checkFingerprint, childEnvironment, digest, fail, fingerprint, integer, keys, nullable, object, oneOf, openRegular, parseJson, range, safeError, sha, str, underRoot } from "./security.ts";

export const DEFAULT_WORKER={concurrency:2,maxJobs:64,leaseMs:30000,timeoutMs:10000,stdoutBytes:2*1024*1024,pageBytes:1024*1024,pageLimit:100};
export function workerOptions(options:WorkerOptions):Required<WorkerOptions>{
  if(!Array.isArray(options.helper)||options.helper.length<1||options.helper.length>16)fail("helper_argv_required");
  options.helper.forEach(x=>str(x,4096));
  const out={...DEFAULT_WORKER,...options};
  integer(out.concurrency,1,32);integer(out.maxJobs,1,10000);integer(out.leaseMs,1000,120000);
  integer(out.timeoutMs,100,60000);integer(out.stdoutBytes,1024,8*1024*1024);
  integer(out.pageBytes,1024,4*1024*1024);integer(out.pageLimit,1,1000);
  if(out.leaseMs<=out.timeoutMs+500)fail("lease_shorter_than_helper_deadline");return out;
}
export async function runHelper(argv:string[],options:Required<WorkerOptions>):Promise<unknown>{
  if(process.platform==="win32")fail("helper_descendant_cleanup_unsupported");
  return new Promise((resolve,reject)=>{
    const child=spawn(argv[0],argv.slice(1),{detached:true,stdio:["ignore","pipe","pipe"],env:childEnvironment("worker")});
    const ownedPid=child.pid;
    const chunks:Buffer[]=[];let outBytes=0,errBytes=0,settling=false;
    const cleanup=async():Promise<boolean>=>{
      if(!ownedPid)return true;
      // The group remains ours even if its leader already closed successfully.
      // Never search process names or signal the caller/source agent group.
      try{process.kill(-ownedPid,"SIGKILL");}catch(e:any){if(e?.code==="ESRCH")return true;if(e?.code!=="EPERM")return false;}
      const deadline=Date.now()+250;
      do{
        try{process.kill(-ownedPid,0);try{process.kill(-ownedPid,"SIGKILL");}catch(e:any){if(e?.code==="ESRCH")return true;if(e?.code!=="EPERM")return false;}}
        catch(e:any){if(e?.code==="ESRCH")return true;if(e?.code!=="EPERM")return false;}
        // macOS can transiently return EPERM while an already exiting group is
        // being reaped. Only later ESRCH proves cleanup; EPERM alone never does.
        await Bun.sleep(10);
      }while(Date.now()<deadline);
      return false;
    };
    const finish=async(code:string|null,value?:unknown)=>{
      if(settling)return;settling=true;clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();
      const clean=await cleanup();
      if(!clean)code="helper_group_cleanup_unverified";
      if(code){try{fail(code);}catch(error){reject(error);}}else resolve(value);
    };
    const rejectCode=(code:string)=>{void finish(code);};
    const timer=setTimeout(()=>rejectCode("helper_deadline_exceeded"),options.timeoutMs);
    child.on("error",()=>rejectCode("helper_spawn_failed"));
    child.stdout.on("data",(chunk:Buffer)=>{outBytes+=chunk.length;if(outBytes>options.stdoutBytes)rejectCode("helper_output_budget_exceeded");else chunks.push(chunk);});
    child.stderr.on("data",(chunk:Buffer)=>{errBytes+=chunk.length;if(errBytes>16*1024)rejectCode("helper_output_budget_exceeded");});
    child.on("close",code=>{
      if(settling)return;if(code!==0){rejectCode("helper_failed");return;}
      try{void finish(null,parseJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));}catch(error){rejectCode(safeError(error));}
    });
  });
}
function pointer(document:unknown,path:string):unknown{
  if(path==="")return document;
  if(!/^\/(?:[^~]|~[01])*$/.test(path))fail("invalid_pointer");
  let value:any=document;
  for(const component of path.slice(1).split("/")){
    const key=component.replace(/~1/g,"/").replace(/~0/g,"~");
    if(value===null||typeof value!=="object"||!Object.hasOwn(value,key))fail("identity_pointer_missing");value=value[key];
  }
  return value;
}
export function validatePage(input:unknown,binding:Binding,source:Source,fd:number,start:number,initialSize:number,options:Required<WorkerOptions>):Page{
  const p=object(input);keys(p,["schema_version","records","next_offset","eof","incomplete_tail","omissions","source_state"]);
  if(p.schema_version!=="ultrafast-atif.page.v1")fail("helper_protocol_version");
  if(!Array.isArray(p.records)||p.records.length>options.pageLimit)fail("helper_record_budget_exceeded");
  const eof=bool(p.eof),tail=bool(p.incomplete_tail);
  const next=p.next_offset===null?null:integer(p.next_offset,start,initialSize);
  if(next===null&&(!eof||tail))fail("invalid_helper_cursor");
  if(!eof&&!tail&&next===start)fail("helper_no_progress");
  if(!Array.isArray(p.omissions)||p.omissions.length>128)fail("invalid_omissions");
  const omissions=p.omissions.map((x:unknown)=>str(x,512));
  let verifiedBytes=0;const slices=new Map<string,{bytes:Buffer;digest:string;document:unknown}>();
  function verified(raw:any):Buffer{
    const offset=integer(raw.offset,start,initialSize);const length=integer(raw.length,1,options.pageBytes);
    if(offset+length>initialSize)fail("helper_source_range_outside_snapshot");
    const key=offset+":"+length;const expected=digest(raw.sha256);
    let slice=slices.get(key);if(!slice){verifiedBytes+=length;if(verifiedBytes>options.pageBytes)fail("helper_source_budget_exceeded");const bytes=range(fd,offset,length);slice={bytes,digest:sha(bytes),document:parseJson(bytes.toString("utf8"))};slices.set(key,slice);}
    if(slice.digest!==expected)fail("helper_source_digest_mismatch");return slice.bytes;
  }
  const document=(raw:any)=>slices.get(raw.offset+":"+raw.length)!.document;
  const seen=new Set<string>();
  const records=p.records.map((item:unknown):NormalizedRecord=>{
    const r=object(item);keys(r,["record_id","client","kind","timestamp","native","source","labels","text_available","identity_evidence","logical","relay","atif","atif_identity_evidence","native_actor","native_actor_evidence"]);
    const native=object(r.native);const names=["session_id","turn_id","entry_id","parent_entry_id","trajectory_id","step_id"] as const;keys(native,[...names]);
    const n:Native={session_id:nullable(native.session_id),turn_id:nullable(native.turn_id),entry_id:nullable(native.entry_id),parent_entry_id:nullable(native.parent_entry_id),trajectory_id:nullable(native.trajectory_id),step_id:native.step_id===null?null:integer(native.step_id,1,Number.MAX_SAFE_INTEGER)};
    const s=object(r.source);keys(s,["uri","format","version","offset","length","sha256","json_pointer"]);
    if(s.uri!==pathToFileURL(source.path).href||s.format!==source.format)fail("helper_source_binding_mismatch");
    const bytes=verified(s);
    const id=str(r.record_id);if(seen.has(id))fail("duplicate_record_in_page");seen.add(id);
    const client=oneOf(r.client,["codex","claude","pi","atif"] as const);
    if(source.format!=="atif"&&client!==source.format)fail("helper_client_mismatch");
    if(source.format!=="atif"&&n.session_id!==null&&n.session_id!==binding.native_session_id)fail("source_native_session_mismatch");
    if(!Array.isArray(r.labels)||r.labels.length>32)fail("invalid_labels");
    const record:NormalizedRecord={record_id:id,client,kind:str(r.kind,128),timestamp:nullable(r.timestamp,128),native:n,
      source:{uri:s.uri,format:s.format,version:s.version===null?null:typeof s.version==="number"?integer(s.version,0,1000000):str(s.version,128),offset:s.offset,length:s.length,sha256:s.sha256,json_pointer:typeof s.json_pointer==="string"&&s.json_pointer.length<=2048?s.json_pointer:fail("invalid_pointer")},
      labels:r.labels.map((label:unknown)=>str(label,128)),text_available:bool(r.text_available)};
    // Validate selectors even when no identity scalar needs proving.
    pointer(document(s),record.source.json_pointer);
    if(r.identity_evidence!==undefined){
      const evidence=object(r.identity_evidence);keys(evidence,[...names]);record.identity_evidence={};
      for(const name of names){
        if(evidence[name]===undefined){if(n[name]!==null)fail("native_identity_evidence_missing");continue;}
        if(n[name]===null)fail("identity_evidence_for_unknown");
        const e=object(evidence[name]);keys(e,["offset","length","sha256","json_pointer"]);const ebytes=verified(e);
        const jp=typeof e.json_pointer==="string"&&e.json_pointer.length<=2048?e.json_pointer:fail("invalid_pointer");
        if(canonical(pointer(document(e),jp))!==canonical(n[name]))fail("native_identity_evidence_mismatch");
        record.identity_evidence[name]={offset:e.offset,length:e.length,sha256:e.sha256,json_pointer:jp};
      }
    } else if(names.some(name=>n[name]!==null))fail("native_identity_evidence_missing");
    if(r.logical!==undefined){const l=object(r.logical);keys(l,["event_id","task_id","run_id","project_id"]);record.logical={event_id:nullable(l.event_id),task_id:nullable(l.task_id),run_id:nullable(l.run_id),project_id:nullable(l.project_id)};}
    if(r.relay!==undefined){const l=object(r.relay);keys(l,["event_uuid","parent_scope_uuid","propagation_root_uuid","atof_version","name"]);record.relay={event_uuid:nullable(l.event_uuid),parent_scope_uuid:nullable(l.parent_scope_uuid),propagation_root_uuid:nullable(l.propagation_root_uuid),atof_version:nullable(l.atof_version),name:str(l.name,128)};}
    function prove(extra:unknown,value:unknown):Evidence{
      const e=object(extra);keys(e,["offset","length","sha256","json_pointer"]);verified(e);
      const jp=typeof e.json_pointer==="string"&&e.json_pointer.length<=2048?e.json_pointer:fail("invalid_pointer");
      if(canonical(pointer(document(e),jp))!==canonical(value))fail("qualified_identity_evidence_mismatch");
      return{offset:e.offset,length:e.length,sha256:e.sha256,json_pointer:jp};
    }
    if(r.atif!==undefined){
      if(source.format!=="atif")fail("atif_namespace_on_non_atif_source");
      const a=object(r.atif);keys(a,["session_id","trajectory_id","step_id"]);
      record.atif={session_id:nullable(a.session_id),trajectory_id:nullable(a.trajectory_id),step_id:a.step_id===null?null:integer(a.step_id,1,Number.MAX_SAFE_INTEGER)};
      const evidence=object(r.atif_identity_evidence);keys(evidence,["session_id","trajectory_id","step_id"]);record.atif_identity_evidence={};
      for(const name of ["session_id","trajectory_id","step_id"] as const){
        if(record.atif[name]!==null)record.atif_identity_evidence[name]=prove(evidence[name],record.atif[name]);
        else if(evidence[name]!==undefined)fail("identity_evidence_for_unknown");
      }
    }else if(r.atif_identity_evidence!==undefined)fail("identity_evidence_without_namespace");
    if(r.native_actor!==undefined){
      if(source.format!=="atif")fail("actor_projection_on_non_atif_source");
      const actor=object(r.native_actor);keys(actor,["client","session_ref","roles","provenance_ref"]);
      if(!Array.isArray(actor.roles)||actor.roles.length<1||actor.roles.length>32||!actor.roles.includes("primary_actor"))fail("native_actor_primary_missing");
      const ref=object(actor.provenance_ref);keys(ref,["record_id","uri","json_pointer","sha256"]);
      const jsonPointer=typeof ref.json_pointer==="string"&&ref.json_pointer.length<=2048&&/^(?:\/(?:[^~]|~[01])*)?$/.test(ref.json_pointer)?ref.json_pointer:fail("invalid_pointer");
      record.native_actor={client:str(actor.client),session_ref:str(actor.session_ref),roles:actor.roles.map((v:unknown)=>str(v,128)),provenance_ref:{record_id:str(ref.record_id),uri:str(ref.uri,2048),json_pointer:jsonPointer,sha256:digest(ref.sha256)}};
      const evidence=object(r.native_actor_evidence);keys(evidence,["client","session_ref","roles","provenance_ref"]);
      record.native_actor_evidence={client:prove(evidence.client,record.native_actor.client),session_ref:prove(evidence.session_ref,record.native_actor.session_ref),roles:prove(evidence.roles,record.native_actor.roles),provenance_ref:prove(evidence.provenance_ref,record.native_actor.provenance_ref)};
    }else if(r.native_actor_evidence!==undefined)fail("identity_evidence_without_actor");
    if(source.format==="atif"&&names.some(name=>n[name]!==null)&&record.native_actor===undefined)fail("atif_identity_is_not_client_native");
    return record;
  });
  if(next!==null && records.some(r=>r.source.offset+r.source.length>next))fail("cursor_before_record_end");
  return {schema_version:p.schema_version,records,next_offset:next,eof,incomplete_tail:tail,omissions};
}
export async function processJob(store:Store,job:Job,inputOptions:WorkerOptions):Promise<string>{
  const options=workerOptions(inputOptions);let fd:number|undefined;
  try{
    const binding=store.binding(job.binding_id);const source=binding.sources.find(s=>s.source_id===job.source_id);if(!source)fail("source_binding_missing");
    underRoot(source.path,binding.source_root);fd=openRegular(source.path);
    const state=store.sourceState(job);checkFingerprint(fd,state.fingerprint,state.cursor);
    if(source.format==="atif"&&state.atif_complete){
      if(fstatSync(fd).size!==state.cursor)fail("atif_source_changed");store.finishUnchanged(job);return "succeeded";
    }
    const info=fstatSync(fd);
    if(info.dev!==job.target_dev||info.ino!==job.target_ino)fail("source_rotated_or_changed");
    if(info.size<job.target_size)fail("source_truncated");
    if(state.cursor>=job.target_size){store.finishUnchanged(job);return "succeeded";}
    const initialSize=job.target_size;const anchor=canonical(fingerprint(fd,state.cursor));
    const argv=[...options.helper,"ingest","--input",source.path,"--format",source.format,"--allow-root",binding.source_root,"--offset",String(state.cursor),"--limit",String(options.pageLimit),"--max-bytes",String(Math.min(options.pageBytes,initialSize-state.cursor)),"--json"];
    const result=await runHelper(argv,options);
    checkFingerprint(fd,anchor,state.cursor);
    // Ensure the pathname still designates this open file; an inode replacement
    // must not make subsequent page pointers silently name a different source.
    const fresh=openRegular(source.path);
    try {const a=fstatSync(fd),b=fstatSync(fresh);if(a.dev!==b.dev||a.ino!==b.ino||a.size<initialSize)fail("source_rotated_or_changed");}finally{closeSync(fresh);}
    const page=validatePage(result,binding,source,fd,state.cursor,initialSize,options);
    const next=page.next_offset??initialSize;
    if(next-state.cursor>options.pageBytes)fail("helper_cursor_budget_exceeded");
    const reachedWindowBudget=initialSize-state.cursor<=options.pageBytes;
    const terminal=next>=initialSize||(reachedWindowBudget&&(page.eof||page.incomplete_tail));
    if(next===state.cursor&&!terminal)fail("record_exceeds_page_budget");
    store.finishPage(job,page,state.cursor,next,canonical(fingerprint(fd,next)),terminal);
    return terminal?"succeeded":"continued";
  }catch(error){
    const code=safeError(error);try{store.failJob(job,code);}catch(fence){if(safeError(fence)!=="stale_worker_fenced")throw fence;}
    return code;
  }finally{if(fd!==undefined)closeSync(fd);}
}
export async function drain(store:Store,inputOptions:WorkerOptions,shouldContinue:()=>boolean=()=>true):Promise<Record<string,unknown>>{
  const options=workerOptions(inputOptions);const owner=randomUUID();let claimed=0;const outcomes:Record<string,number>={};
  const lane=async()=>{while(claimed<options.maxJobs&&shouldContinue()){const job=store.claim(owner,options.leaseMs,Date.now(),options.concurrency);if(!job)break;claimed++;const outcome=await processJob(store,job,options);outcomes[outcome]=(outcomes[outcome]??0)+1;}};
  await Promise.all(Array.from({length:options.concurrency},lane));
  return {schema_version:"task-checkpoint-record.drain.v1",claimed,outcomes,concurrency:options.concurrency};
}
export async function runService(store:Store,options:WorkerOptions,signal?:AbortSignal):Promise<void>{
  workerOptions(options);const token=randomUUID();store.registerService(token);
  const timer=setInterval(()=>{try{store.heartbeat(token);}catch{/* main loop owns final status */}},1000);
  const alive=()=>!signal?.aborted&&store.heartbeat(token);
  try {while(alive()){await drain(store,options,alive);if(!signal?.aborted)await Bun.sleep(100);}}
  finally{clearInterval(timer);store.serviceStopped(token);}
}

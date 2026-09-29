import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Store } from "./store.ts";
import { canonical, digest, fail, integer, keys, object, sha, str } from "./security.ts";
import { validateSupervisorPolicy } from "./supervisor-policy.ts";
import type { AgentNativeReceipt, SupervisorActivation, SupervisorPolicy, SupervisorReduction, SupervisorRun, SupervisorSnapshot, WorkerReport, WorkerTaskSpec } from "./supervisor-types.ts";
import type { Job } from "./types.ts";

export interface ActivateSupervisor {
  activation_id:string; binding_id:string; policy:SupervisorPolicy;
  runtime_config:Record<string,unknown>; include_existing_windows?:boolean;
}
const SCHEMA=`
CREATE TABLE agent_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO agent_meta VALUES('version','1');
CREATE TABLE agent_activations(activation_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings,task_id TEXT NOT NULL,daemon_id TEXT NOT NULL,policy_sha256 TEXT NOT NULL,body TEXT NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL,start_after_window_rowid INTEGER NOT NULL,rounds_reserved INTEGER NOT NULL DEFAULT 0,native_calls INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,tool_output_bytes INTEGER NOT NULL DEFAULT 0,external_calls INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX agent_active_binding ON agent_activations(binding_id) WHERE active=1;
CREATE TABLE agent_wakes(activation_id TEXT NOT NULL REFERENCES agent_activations,window_id TEXT NOT NULL REFERENCES windows,state TEXT NOT NULL DEFAULT 'waiting',created_at INTEGER NOT NULL,error_code TEXT,PRIMARY KEY(activation_id,window_id));
CREATE TABLE agent_snapshots(snapshot_sha256 TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE agent_runs(run_id TEXT PRIMARY KEY,activation_id TEXT NOT NULL REFERENCES agent_activations,window_id TEXT NOT NULL REFERENCES windows,snapshot_sha256 TEXT NOT NULL REFERENCES agent_snapshots,policy_sha256 TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',phase TEXT NOT NULL DEFAULT 'queued',lease_token TEXT,lease_until INTEGER,generation INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,model_started INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,error_code TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(activation_id,window_id,policy_sha256));
CREATE TABLE agent_attempts(run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,lease_token TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,PRIMARY KEY(run_id,generation));
CREATE TABLE agent_model_calls(call_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,role TEXT NOT NULL,worker_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,native_json TEXT,result_json TEXT,error_code TEXT);
CREATE TABLE agent_sessions(epoch_id TEXT PRIMARY KEY,activation_id TEXT NOT NULL REFERENCES agent_activations,identity_json TEXT NOT NULL,previous_epoch_id TEXT,created_at INTEGER NOT NULL,close_json TEXT,closed_at INTEGER,close_error TEXT);
CREATE TABLE agent_session_rounds(epoch_id TEXT NOT NULL REFERENCES agent_sessions,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,PRIMARY KEY(epoch_id,run_id,generation));
CREATE TABLE agent_workers(worker_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,task_key TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',lease_until INTEGER,call_id TEXT,result_json TEXT,error_code TEXT,process_closed INTEGER NOT NULL DEFAULT 0,close_json TEXT,UNIQUE(run_id,generation,task_key));
CREATE TABLE agent_tool_calls(tool_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,worker_id TEXT,tool TEXT NOT NULL,state TEXT NOT NULL,argument_sha256 TEXT NOT NULL,native_json TEXT,result_sha256 TEXT,result_bytes INTEGER NOT NULL DEFAULT 0,wire_result_sha256 TEXT);
CREATE TABLE agent_evidence(evidence_ref TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,worker_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE agent_external_attempts(activation_id TEXT NOT NULL,packet_sha256 TEXT NOT NULL,packet_handle TEXT NOT NULL,run_id TEXT NOT NULL,generation INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(activation_id,packet_sha256));
CREATE TABLE agent_proposals(proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs,generation INTEGER NOT NULL,snapshot_sha256 TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,generation));
CREATE TABLE agent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,generation INTEGER,event TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE agent_services(daemon_id TEXT PRIMARY KEY,token TEXT NOT NULL,pid INTEGER NOT NULL,heartbeat INTEGER NOT NULL,state TEXT NOT NULL,stop_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE agent_stop_guards(activation_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(activation_id,turn_id));
CREATE TRIGGER agent_snapshot_immutable BEFORE UPDATE ON agent_snapshots BEGIN SELECT RAISE(ABORT,'immutable agent snapshot'); END;
CREATE TRIGGER agent_proposal_immutable BEFORE UPDATE ON agent_proposals BEGIN SELECT RAISE(ABORT,'immutable agent proposal'); END;
CREATE TRIGGER agent_evidence_immutable BEFORE UPDATE ON agent_evidence BEGIN SELECT RAISE(ABORT,'immutable agent evidence'); END;`;

/** A separate opt-in namespace inside the already private recorder database. */
export class SupervisorStore {
  constructor(readonly base:Store) {}
  get db(){return this.base.db;}
  initialized():boolean{return !!this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_meta'").get();}
  initialize():void{
    this.db.transaction(()=>{
      if(!this.initialized())this.db.exec(SCHEMA);
      const v=this.db.query("SELECT value FROM agent_meta WHERE key='version'").get() as {value:string}|null;
      if(v?.value!=="1")fail("supervisor_store_version");
    }).immediate();
  }
  private requireInitialized():void{if(!this.initialized())fail("supervisor_not_initialized");}
  private event(event:string,run:Pick<SupervisorRun,"run_id"|"generation">|null,body:unknown,now=Date.now()):void{
    const text=canonical(body);if(Buffer.byteLength(text)>256*1024)fail("agent_event_budget");
    this.db.query("INSERT INTO agent_events(run_id,generation,event,body,created_at) VALUES(?,?,?,?,?)").run(run?.run_id??null,run?.generation??null,event,text,now);
  }
  activate(input:ActivateSupervisor,now=Date.now()):SupervisorActivation{
    keys(object(input),["activation_id","binding_id","policy","runtime_config","include_existing_windows"]);
    str(input.activation_id);str(input.binding_id);const policy=validateSupervisorPolicy(input.policy);
    const runtime=object(input.runtime_config);if(Buffer.byteLength(canonical(runtime))>256*1024||sha(canonical(runtime))!==policy.config_sha256)fail("activation_config_digest_mismatch");
    if(input.include_existing_windows!==undefined&&typeof input.include_existing_windows!=="boolean")fail("invalid_activation_scope");
    const binding=this.base.binding(input.binding_id),active=this.base.activeBinding(binding.client,binding.profile,binding.native_session_id);
    if(binding.role!=="master"||active?.binding_id!==binding.binding_id)fail("activation_requires_bound_master");
    this.initialize();const policyHash=sha(canonical(policy));
    return this.db.transaction(()=>{
      const old=this.db.query("SELECT body,active FROM agent_activations WHERE activation_id=?").get(input.activation_id) as {body:string;active:number}|null;
      if(old){const value=JSON.parse(old.body) as SupervisorActivation;if(value.binding_id!==input.binding_id||value.policy_sha256!==policyHash||canonical(value.runtime_config)!==canonical(runtime))fail("activation_conflict");return{...value,active:!!old.active};}
      if(this.db.query("SELECT activation_id FROM agent_activations WHERE binding_id=? AND active=1").get(input.binding_id))fail("binding_already_has_supervisor");
      const last=(this.db.query("SELECT COALESCE(MAX(rowid),0) AS n FROM windows WHERE binding_id=?").get(input.binding_id) as {n:number}).n;
      const activation:SupervisorActivation={activation_id:input.activation_id,binding_id:input.binding_id,task_id:binding.task_id,daemon_id:policy.daemon_id,policy_sha256:policyHash,policy,runtime_config:structuredClone(runtime),created_at:now,start_after_window_rowid:input.include_existing_windows?0:last,active:true};
      this.db.query("INSERT INTO agent_activations(activation_id,binding_id,task_id,daemon_id,policy_sha256,body,active,created_at,start_after_window_rowid) VALUES(?,?,?,?,?,?,1,?,?)")
        .run(activation.activation_id,binding.binding_id,binding.task_id,policy.daemon_id,policyHash,canonical(activation),now,activation.start_after_window_rowid);
      this.event("activation_created",null,{activation_id:activation.activation_id,binding_id:binding.binding_id,policy_sha256:policyHash},now);
      return activation;
    }).immediate();
  }
  activation(id:string):SupervisorActivation{
    this.requireInitialized();const row=this.db.query("SELECT body,active,policy_sha256,binding_id,task_id,daemon_id FROM agent_activations WHERE activation_id=?").get(str(id)) as any;
    if(!row)fail("activation_not_found");const value=JSON.parse(row.body) as SupervisorActivation;
    if(value.activation_id!==id||value.binding_id!==row.binding_id||value.task_id!==row.task_id||value.daemon_id!==row.daemon_id||value.policy_sha256!==row.policy_sha256||sha(canonical(value.policy))!==row.policy_sha256||sha(canonical(value.runtime_config))!==value.policy.config_sha256)fail("stored_activation_changed");
    return{...value,active:!!row.active};
  }
  activations(daemonId?:string):SupervisorActivation[]{
    if(!this.initialized())return[];
    if(daemonId)str(daemonId);
    const rows=this.db.query(`SELECT activation_id FROM agent_activations WHERE active=1 ${daemonId?"AND daemon_id=?":""} ORDER BY rowid LIMIT 32`).all(...(daemonId?[daemonId]:[])) as {activation_id:string}[];
    return rows.map(row=>this.activation(row.activation_id));
  }
  deactivate(id:string,now=Date.now()):boolean{
    this.requireInitialized();return this.db.transaction(()=>{
      const changed=this.db.query("UPDATE agent_activations SET active=0 WHERE activation_id=? AND active=1").run(str(id)).changes===1;
      this.db.query("UPDATE agent_runs SET cancel_requested=1 WHERE activation_id=? AND state='running'").run(id);
      this.db.query("UPDATE agent_runs SET state='cancelled',phase='cancelled',finished_at=? WHERE activation_id=? AND state='queued'").run(now,id);
      if(changed)this.event("activation_deactivated",null,{activation_id:id},now);return changed;
    }).immediate();
  }
  wake(bindingId:string,windowId:string,now=Date.now()):Record<string,unknown>{
    if(!this.initialized())return{accepted:false,reason:"not_activated"};
    const row=this.db.query(`SELECT a.activation_id,a.daemon_id FROM agent_activations a JOIN bindings b ON b.binding_id=a.binding_id JOIN windows w ON w.binding_id=a.binding_id
      WHERE a.active=1 AND b.active=1 AND b.role='master' AND a.binding_id=? AND w.window_id=? AND w.rowid>a.start_after_window_rowid`).get(str(bindingId),str(windowId)) as {activation_id:string;daemon_id:string}|null;
    if(!row)return{accepted:false,reason:"inactive_or_outside_activation"};
    const inserted=this.db.query("INSERT OR IGNORE INTO agent_wakes(activation_id,window_id,created_at) VALUES(?,?,?)").run(row.activation_id,windowId,now).changes===1;
    return{accepted:true,duplicate:!inserted,activation_id:row.activation_id,daemon_id:row.daemon_id,model_started:false};
  }
  captureSnapshot(windowId:string):SupervisorSnapshot{
    const window=this.db.query("SELECT binding_id,task_id,native_session_id,hook_turn_id,created_at,body FROM windows WHERE window_id=?").get(str(windowId)) as any;
    if(!window)fail("window_not_found");
    const counts=this.db.query("SELECT COUNT(*) AS total,SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS done FROM jobs WHERE window_id=?").get(windowId) as {total:number;done:number};
    if(counts.total===0||counts.done!==counts.total)fail("window_extraction_not_complete");
    const binding=this.base.binding(window.binding_id),total=(this.db.query("SELECT COUNT(*) AS n FROM record_windows WHERE window_id=?").get(windowId) as {n:number}).n;
    const rows=this.db.query("SELECT r.record_id,r.body FROM records r JOIN record_windows w ON w.record_id=r.record_id WHERE w.window_id=? ORDER BY r.rowid LIMIT 1001").all(windowId) as {record_id:string;body:string}[];
    const refs:SupervisorSnapshot["record_refs"]=[];let bytes=0;
    for(const row of rows.slice(0,1000)){const metadata=JSON.parse(row.body);const ref={handle:"record:"+sha(row.record_id),record_id:row.record_id,sha256:sha(canonical(metadata)),metadata};const size=Buffer.byteLength(canonical(ref));if(bytes+size>3*1024*1024)break;refs.push(ref);bytes+=size;}
    const pages=this.db.query("SELECT page_id,body FROM pages WHERE window_id=? ORDER BY rowid LIMIT 257").all(windowId) as {page_id:string;body:string}[];
    const page_refs=pages.slice(0,256).map(p=>{const metadata=JSON.parse(p.body);return{page_id:p.page_id,sha256:sha(canonical(metadata)),metadata};});
    const content:Omit<SupervisorSnapshot,"snapshot_sha256">={schema_version:"task-checkpoint-record.supervisor-snapshot.v1",store_id:this.base.storeId,binding_id:binding.binding_id,task_id:binding.task_id,window_id:windowId,
      window_sha256:sha(window.body),binding_sha256:sha(canonical(binding)),created_at:new Date(window.created_at).toISOString(),task_native:{client:binding.client,profile:binding.profile,session_id:binding.native_session_id,hook_turn_id:window.hook_turn_id},
      source_root:binding.source_root,sources:binding.sources,record_refs:refs,page_refs,
      coverage:{kind:"metadata_only",selected_records:refs.length,total_records:total,truncated:refs.length!==total||pages.length>256,omissions:["This is an incremental metadata window, not full task coverage or a sealed owner checkpoint.",...(refs.length!==total?["Record selection was bounded by count/byte limits."]:[]),...(pages.length>256?["Page receipt selection was bounded."]:[])]}};
    if(Buffer.byteLength(canonical(content))>4*1024*1024)fail("snapshot_budget_exceeded");
    return{...content,snapshot_sha256:sha(canonical(content))};
  }
  claimExtraction(activationId:string,owner:string,leaseMs:number,now=Date.now()):Job|null{
    integer(leaseMs,1000,120000);str(owner);
    return this.db.transaction(()=>{
      const activation=this.activation(activationId);if(!activation.active)return null;
      const running=(this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE state='running' AND lease_until>?").get(now) as {n:number}).n;
      if(running>=32)return null;
      const job=this.db.query(`SELECT j.* FROM jobs j JOIN windows w ON w.window_id=j.window_id JOIN bindings b ON b.binding_id=j.binding_id
        WHERE j.binding_id=? AND w.rowid>? AND b.active=1 AND b.role='master' AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?))
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.binding_id=j.binding_id AND other.source_id=j.source_id AND other.state='running' AND other.lease_until>? AND other.job_id!=j.job_id)
        ORDER BY j.rowid LIMIT 1`).get(activation.binding_id,activation.start_after_window_rowid,now,now) as Job|null;
      if(!job)return null;
      this.db.query("UPDATE jobs SET state='running',lease_token=?,lease_until=?,generation=generation+1,attempts=attempts+1,error_code=NULL WHERE job_id=?").run(owner+":"+randomUUID(),now+leaseMs,job.job_id);
      return this.db.query("SELECT * FROM jobs WHERE job_id=?").get(job.job_id) as Job;
    }).immediate();
  }
  snapshot(hash:string):SupervisorSnapshot{
    this.requireInitialized();const row=this.db.query("SELECT body FROM agent_snapshots WHERE snapshot_sha256=?").get(digest(hash)) as {body:string}|null;
    if(!row)fail("snapshot_not_found");const snapshot=JSON.parse(row.body) as SupervisorSnapshot;const{snapshot_sha256,...body}=snapshot;
    if(snapshot_sha256!==hash||sha(canonical(body))!==hash)fail("snapshot_changed");return snapshot;
  }
  enqueueReady(limit=20,daemonId?:string,now=Date.now()):Record<string,number>{
    this.requireInitialized();integer(limit,1,100);if(daemonId)str(daemonId);
    // Polling recovers a process death between deterministic ingress and wake.
    const seed=this.db.query(`SELECT a.activation_id,w.window_id FROM agent_activations a JOIN bindings b ON b.binding_id=a.binding_id JOIN windows w ON w.binding_id=a.binding_id
      WHERE a.active=1 AND b.active=1 AND b.role='master' AND w.rowid>a.start_after_window_rowid ${daemonId?"AND a.daemon_id=?":""}
      AND NOT EXISTS(SELECT 1 FROM agent_wakes x WHERE x.activation_id=a.activation_id AND x.window_id=w.window_id) ORDER BY w.rowid LIMIT ?`).all(...(daemonId?[daemonId]:[]),limit) as {activation_id:string;window_id:string}[];
    for(const s of seed)this.db.query("INSERT OR IGNORE INTO agent_wakes(activation_id,window_id,created_at) VALUES(?,?,?)").run(s.activation_id,s.window_id,now);
    const ready=this.db.query(`SELECT w.activation_id,w.window_id FROM agent_wakes w JOIN agent_activations a ON a.activation_id=w.activation_id
      WHERE w.state='waiting' AND a.active=1 ${daemonId?"AND a.daemon_id=?":""} AND EXISTS(SELECT 1 FROM jobs j WHERE j.window_id=w.window_id)
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.window_id=w.window_id AND j.state!='succeeded') ORDER BY w.rowid LIMIT ?`).all(...(daemonId?[daemonId]:[]),limit) as {activation_id:string;window_id:string}[];
    const result={queued:0,empty:0,budget_exhausted:0};
    for(const row of ready)this.db.transaction(()=>{
      const wake=this.db.query("SELECT state FROM agent_wakes WHERE activation_id=? AND window_id=?").get(row.activation_id,row.window_id) as {state:string}|null;
      if(wake?.state!=="waiting")return;
      const activation=this.activation(row.activation_id),snapshot=this.captureSnapshot(row.window_id);
      if(!activation.active)return;
      if(!snapshot.record_refs.length){this.db.query("UPDATE agent_wakes SET state='empty',error_code='no_selected_records' WHERE activation_id=? AND window_id=?").run(row.activation_id,row.window_id);result.empty++;return;}
      const usage=this.db.query("SELECT rounds_reserved FROM agent_activations WHERE activation_id=?").get(row.activation_id) as {rounds_reserved:number};
      if(usage.rounds_reserved>=activation.policy.max_rounds){this.db.query("UPDATE agent_wakes SET state='budget_exhausted',error_code='activation_round_budget' WHERE activation_id=? AND window_id=?").run(row.activation_id,row.window_id);result.budget_exhausted++;return;}
      const runId="agent_run_"+sha(canonical([row.activation_id,row.window_id,activation.policy_sha256]));
      this.db.query("INSERT OR IGNORE INTO agent_snapshots VALUES(?,?)").run(snapshot.snapshot_sha256,canonical(snapshot));
      const inserted=this.db.query("INSERT OR IGNORE INTO agent_runs(run_id,activation_id,window_id,snapshot_sha256,policy_sha256,created_at) VALUES(?,?,?,?,?,?)").run(runId,row.activation_id,row.window_id,snapshot.snapshot_sha256,activation.policy_sha256,now).changes;
      if(inserted){this.db.query("UPDATE agent_activations SET rounds_reserved=rounds_reserved+1 WHERE activation_id=?").run(row.activation_id);result.queued++;this.event("run_queued",{run_id:runId,generation:0},{snapshot_sha256:snapshot.snapshot_sha256},now);}
      this.db.query("UPDATE agent_wakes SET state='queued' WHERE activation_id=? AND window_id=?").run(row.activation_id,row.window_id);
    }).immediate();
    return result;
  }
  run(id:string):SupervisorRun{this.requireInitialized();const run=this.db.query("SELECT * FROM agent_runs WHERE run_id=?").get(str(id)) as SupervisorRun|null;if(!run)fail("agent_run_not_found");return run;}
  recoverExpired(now=Date.now()):number{
    this.requireInitialized();return this.db.transaction(()=>{
      const rows=this.db.query("SELECT * FROM agent_runs WHERE state='running' AND lease_until<=?").all(now) as SupervisorRun[];
      for(const row of rows){const state=row.cancel_requested?"cancelled":row.model_started?"interrupted":"queued";
        this.db.query("UPDATE agent_runs SET state=?,phase=?,lease_token=NULL,lease_until=NULL,error_code=? WHERE run_id=?").run(state,state,row.model_started?"model_outcome_unknown_requires_explicit_retry":null,row.run_id);
        this.db.query("UPDATE agent_attempts SET state=?,finished_at=? WHERE run_id=? AND generation=?").run(state==="queued"?"abandoned_before_model":state,now,row.run_id,row.generation);
        this.db.query("UPDATE agent_model_calls SET state='unknown',error_code='lease_expired' WHERE run_id=? AND generation=? AND state IN ('reserved','started')").run(row.run_id,row.generation);
        this.db.query("UPDATE agent_workers SET state='interrupted',error_code='lease_expired' WHERE run_id=? AND generation=? AND state IN ('queued','running')").run(row.run_id,row.generation);
        this.event("lease_expired",row,{state,automatic_model_retry:false},now);
      }return rows.length;
    }).immediate();
  }
  claim(owner:string,daemonId:string,now=Date.now()):SupervisorRun|null{
    str(owner);str(daemonId);this.recoverExpired(now);
    for(const activation of this.activations(daemonId))this.reconcileWorkerGroups(activation.activation_id);
    return this.db.transaction(()=>{
      const row=this.db.query(`SELECT r.* FROM agent_runs r JOIN agent_activations a ON a.activation_id=r.activation_id JOIN bindings b ON b.binding_id=a.binding_id
        WHERE r.state='queued' AND a.active=1 AND b.active=1 AND b.role='master' AND a.daemon_id=?
        AND NOT EXISTS(SELECT 1 FROM agent_workers unknown JOIN agent_runs prior ON prior.run_id=unknown.run_id WHERE prior.activation_id=r.activation_id AND unknown.call_id IS NOT NULL AND unknown.process_closed=0)
        AND NOT EXISTS(SELECT 1 FROM agent_runs other WHERE other.activation_id=r.activation_id AND other.state='running') ORDER BY r.rowid LIMIT 1`).get(daemonId) as SupervisorRun|null;
      if(!row)return null;const activation=this.activation(row.activation_id);
      if(row.attempts>=activation.policy.max_attempts){this.db.query("UPDATE agent_runs SET state='failed',error_code='attempt_budget_exhausted' WHERE run_id=?").run(row.run_id);return null;}
      const token=owner+":"+randomUUID(),generation=row.generation+1;
      this.db.query("UPDATE agent_runs SET state='running',phase='claimed',lease_token=?,lease_until=?,generation=?,attempts=attempts+1,model_started=0,cancel_requested=0,error_code=NULL WHERE run_id=?").run(token,now+activation.policy.lease_ms,generation,row.run_id);
      this.db.query("INSERT INTO agent_attempts VALUES(?,?,?,'running',?,NULL)").run(row.run_id,generation,token,now);return this.run(row.run_id);
    }).immediate();
  }
  assertActive(run:SupervisorRun,now=Date.now()):void{
    if(!this.db.query(`SELECT r.run_id FROM agent_runs r JOIN agent_activations a ON a.activation_id=r.activation_id JOIN bindings b ON b.binding_id=a.binding_id
      WHERE r.run_id=? AND r.generation=? AND r.lease_token=? AND r.state='running' AND r.lease_until>? AND r.cancel_requested=0 AND a.active=1 AND b.active=1 AND b.role='master'`)
      .get(run.run_id,run.generation,run.lease_token,now))fail("agent_lease_or_activation_fenced");
  }
  renew(run:SupervisorRun,now=Date.now()):boolean{
    return this.db.transaction(()=>{try{this.assertActive(run,now);}catch{return false;}const until=now+this.activation(run.activation_id).policy.lease_ms;
      this.db.query("UPDATE agent_runs SET lease_until=? WHERE run_id=?").run(until,run.run_id);
      this.db.query("UPDATE agent_workers SET lease_until=? WHERE run_id=? AND generation=? AND state='running'").run(until,run.run_id,run.generation);return true;
    }).immediate();
  }
  reserveNative(run:SupervisorRun,role:"supervisor"|"worker",workerId:string|null=null,now=Date.now()):string{
    return this.db.transaction(()=>{this.assertActive(run,now);const activation=this.activation(run.activation_id);
      const used=(this.db.query("SELECT COUNT(*) AS n FROM agent_model_calls WHERE run_id=? AND generation=?").get(run.run_id,run.generation) as {n:number}).n;
      const total=(this.db.query("SELECT native_calls FROM agent_activations WHERE activation_id=?").get(run.activation_id) as {native_calls:number}).native_calls;
      if(used>=activation.policy.native_call_budget||total>=activation.policy.total_native_calls)fail("agent_native_turn_budget");
      const id="agent_call_"+sha(canonical([run.run_id,run.generation,role,workerId]));
      if(this.db.query("SELECT call_id FROM agent_model_calls WHERE call_id=?").get(id))fail("native_call_already_reserved");
      this.db.query("INSERT INTO agent_model_calls(call_id,run_id,generation,role,worker_id,state,created_at) VALUES(?,?,?,?,?,'reserved',?)").run(id,run.run_id,run.generation,role,workerId,now);
      if(workerId)this.db.query("UPDATE agent_workers SET call_id=? WHERE worker_id=? AND run_id=? AND generation=?").run(id,workerId,run.run_id,run.generation);
      this.db.query("UPDATE agent_activations SET native_calls=native_calls+1 WHERE activation_id=?").run(run.activation_id);
      this.db.query("UPDATE agent_runs SET model_started=1,phase='native_turn_reserved' WHERE run_id=?").run(run.run_id);
      this.event("native_turn_reserved",run,{call_id:id,role,worker_id:workerId},now);return id;
    }).immediate();
  }
  nativeStarted(run:SupervisorRun,callId:string,native:Record<string,unknown>):void{
    this.assertActive(run);const body=canonical({...native,_observer_host:sha(hostname())});if(Buffer.byteLength(body)>4096)fail("native_identity_budget");
    const updated=this.db.query("UPDATE agent_model_calls SET state='started',native_json=? WHERE call_id=? AND run_id=? AND generation=? AND state='reserved'").run(body,callId,run.run_id,run.generation).changes;
    if(updated!==1)fail("native_call_state_conflict");
  }
  completeNative(run:SupervisorRun,callId:string,receipt:AgentNativeReceipt,result:unknown):void{
    this.db.transaction(()=>{this.assertActive(run);const native=canonical(receipt),output=canonical(result);if(Buffer.byteLength(native)>256*1024||Buffer.byteLength(output)>64*1024)fail("agent_result_budget");
      const updated=this.db.query("UPDATE agent_model_calls SET state='completed',native_json=?,result_json=? WHERE call_id=? AND run_id=? AND generation=? AND state IN ('reserved','started')").run(native,output,callId,run.run_id,run.generation).changes;
      if(updated!==1)fail("native_call_state_conflict");
    }).immediate();
  }
  admitFanout(run:SupervisorRun,tasks:WorkerTaskSpec[],parentNative?:Record<string,unknown>):{worker_id:string;task:WorkerTaskSpec}[]{
    return this.db.transaction(()=>{this.assertActive(run);const activation=this.activation(run.activation_id),snapshot=this.snapshot(run.snapshot_sha256);
      if(this.db.query("SELECT worker_id FROM agent_workers WHERE run_id=? AND generation=? LIMIT 1").get(run.run_id,run.generation))fail("fanout_already_admitted");
      if(!Array.isArray(tasks)||tasks.length<1||tasks.length>activation.policy.max_workers)fail("fanout_budget_exceeded");
      const allowed=new Set(snapshot.record_refs.map(r=>r.handle)),seen=new Set<string>();
      const admitted=tasks.map(task=>{keys(object(task),["task_key","objective","record_handles"]);const key=str(task.task_key,64);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)||seen.has(key))fail("invalid_worker_task_key");seen.add(key);if(typeof task.objective!=="string"||!task.objective.trim()||task.objective.length>2048||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(task.objective))fail("invalid_worker_objective");
        if(task.record_handles!==undefined&&(!Array.isArray(task.record_handles)||task.record_handles.length<1||task.record_handles.length>1000||new Set(task.record_handles).size!==task.record_handles.length||task.record_handles.some(h=>!allowed.has(h))))fail("worker_selection_outside_snapshot");
        const worker_id="agent_worker_"+sha(canonical([run.run_id,run.generation,key]));return{worker_id,task:structuredClone(task)};});
      for(const a of admitted)this.db.query("INSERT INTO agent_workers(worker_id,run_id,generation,task_key,body) VALUES(?,?,?,?,?)").run(a.worker_id,run.run_id,run.generation,a.task.task_key,canonical(a.task));
      this.db.query("UPDATE agent_runs SET phase='worker_fanout' WHERE run_id=?").run(run.run_id);this.event("fanout_admitted",run,{worker_ids:admitted.map(a=>a.worker_id),host_dispatch_parent:parentNative??null,native_parent_relationship_claimed:false});return admitted;
    }).immediate();
  }
  claimWorker(run:SupervisorRun,workerId:string,now=Date.now()):boolean{
    this.reconcileWorkerGroups(run.activation_id);
    return this.db.transaction(()=>{this.assertActive(run,now);const policy=this.activation(run.activation_id).policy;
      const global=(this.db.query("SELECT COUNT(*) AS n FROM agent_workers WHERE state='running' OR (call_id IS NOT NULL AND process_closed=0)").get() as {n:number}).n;
      const local=(this.db.query("SELECT COUNT(*) AS n FROM agent_workers w JOIN agent_runs r ON r.run_id=w.run_id WHERE r.activation_id=? AND (w.state='running' OR (w.call_id IS NOT NULL AND w.process_closed=0))").get(run.activation_id) as {n:number}).n;
      if(global>=32||local>=policy.worker_concurrency)return false;
      return this.db.query("UPDATE agent_workers SET state='running',lease_until=? WHERE worker_id=? AND run_id=? AND generation=? AND state='queued'").run(this.run(run.run_id).lease_until,workerId,run.run_id,run.generation).changes===1;
    }).immediate();
  }
  completeWorker(run:SupervisorRun,workerId:string,callId:string,result:WorkerReport):void{
    this.db.transaction(()=>{this.assertActive(run);
      if((this.db.query("SELECT COUNT(*) AS n FROM agent_evidence WHERE run_id=? AND generation=? AND worker_id=?").get(run.run_id,run.generation,workerId) as {n:number}).n<1)fail("worker_has_no_ptc_evidence");
      const changed=this.db.query("UPDATE agent_workers SET state='succeeded',call_id=?,result_json=? WHERE worker_id=? AND run_id=? AND generation=? AND state='running' AND process_closed=1").run(callId,canonical(result),workerId,run.run_id,run.generation).changes;
      if(changed!==1)fail("worker_state_conflict");
    }).immediate();
  }
  verifyWorkerEvidence(run:SupervisorRun,workerId:string,native:{threadId:string;turnId:string},toolReceipts:Record<string,any>[]):void{
    const evidence=this.db.query("SELECT body FROM agent_evidence WHERE run_id=? AND generation=? AND worker_id=?").all(run.run_id,run.generation,workerId) as {body:string}[];
    if(!evidence.length)fail("worker_has_no_ptc_evidence");
    for(const row of evidence){const receipt=JSON.parse(row.body);
      if(receipt.thread_id!==native.threadId||receipt.turn_id!==native.turnId||receipt.status!=="completed"||!receipt.result)fail("ptc_native_identity_mismatch");
      const match=toolReceipts.find(t=>t.callId===receipt.call_id&&t.threadId===native.threadId&&t.turnId===native.turnId&&t.tool===receipt.tool&&t.status==="succeeded");
      const wireHash=sha(canonical({data_class:receipt.result.dataClass,value:receipt.result.value}));
      if(!match||match.resultSha256!==wireHash||match.dataClass!==receipt.result.dataClass)fail("ptc_native_tool_receipt_mismatch");
    }
  }
  recordWorkerClosure(run:SupervisorRun,workerId:string,receipt:Record<string,any>):boolean{
    // An old attempt may supply its own late cleanup observation, but cannot
    // promote results or alter another generation's workers.
    if(!this.db.query("SELECT run_id FROM agent_attempts WHERE run_id=? AND generation=? AND lease_token=?").get(run.run_id,run.generation,run.lease_token))fail("worker_close_observation_fenced");
    if(receipt.schemaVersion!=="task-checkpoint.agent-close.v1"||receipt.ownedProcessClosed!==true||receipt.ownedProcessGroupClosed!==true||!Number.isSafeInteger(receipt.pid)||receipt.pid<2)return false;
    const row=this.db.query("SELECT c.native_json FROM agent_workers w LEFT JOIN agent_model_calls c ON c.call_id=w.call_id WHERE w.worker_id=? AND w.run_id=? AND w.generation=?").get(workerId,run.run_id,run.generation) as {native_json:string|null}|null;
    if(!row)fail("worker_close_observation_fenced");const native=row.native_json?JSON.parse(row.native_json):null;
    if(native?.pid!==undefined&&native.pid!==receipt.pid)fail("worker_close_pid_mismatch");
    if(native?.threadId!==undefined&&receipt.native?.threadId!==native.threadId)fail("worker_close_thread_mismatch");
    this.db.query("UPDATE agent_workers SET process_closed=1,close_json=? WHERE worker_id=? AND run_id=? AND generation=?").run(canonical(receipt),workerId,run.run_id,run.generation);return true;
  }
  reconcileWorkerGroups(activationId:string):number{
    // Read-only kernel observations release capacity only when the exact
    // previously observed group is absent. No PID is killed during recovery.
    const rows=this.db.query(`SELECT w.worker_id,c.native_json FROM agent_workers w JOIN agent_runs r ON r.run_id=w.run_id JOIN agent_model_calls c ON c.call_id=w.call_id
      WHERE r.activation_id=? AND w.state!='running' AND w.process_closed=0 LIMIT 32`).all(activationId) as {worker_id:string;native_json:string|null}[];
    let released=0;
    for(const row of rows){const n=row.native_json?JSON.parse(row.native_json):null,pid=n?.pid??n?.runtime_receipt?.runtime?.pid;if(n?._observer_host!==sha(hostname())||!Number.isSafeInteger(pid)||pid<2)continue;
      try{process.kill(-pid,0);}catch(error:any){if(error?.code!=="ESRCH")continue;
        const observation={schema_version:"task-checkpoint-record.process-group-observation.v1",pid,process_group_absent:true,observed_at:new Date().toISOString(),native_outcome:"unknown",host_handlers_settled:"unavailable"};
        released+=this.db.query("UPDATE agent_workers SET process_closed=1,close_json=? WHERE worker_id=? AND state!='running' AND process_closed=0").run(canonical(observation),row.worker_id).changes;
      }
    }return released;
  }
  reserveTool(run:SupervisorRun,workerId:string|null,tool:string,args:unknown):string{
    return this.db.transaction(()=>{this.assertActive(run);const policy=this.activation(run.activation_id).policy;
      const used=(this.db.query("SELECT COUNT(*) AS n FROM agent_tool_calls WHERE run_id=? AND generation=?").get(run.run_id,run.generation) as {n:number}).n;
      const total=(this.db.query("SELECT tool_calls FROM agent_activations WHERE activation_id=?").get(run.activation_id) as {tool_calls:number}).tool_calls;
      if(used>=policy.tool_call_budget||total>=policy.total_tool_calls)fail("agent_tool_budget");
      const id="agent_tool_"+randomUUID();this.db.query("INSERT INTO agent_tool_calls(tool_id,run_id,generation,worker_id,tool,state,argument_sha256) VALUES(?,?,?,?,?,'reserved',?)").run(id,run.run_id,run.generation,workerId,str(tool,128),sha(canonical(args)));
      this.db.query("UPDATE agent_activations SET tool_calls=tool_calls+1 WHERE activation_id=?").run(run.activation_id);return id;
    }).immediate();
  }
  completeTool(run:SupervisorRun,id:string,native:Record<string,unknown>,result:unknown):void{
    this.db.transaction(()=>{this.assertActive(run);const policy=this.activation(run.activation_id).policy,bytes=Buffer.byteLength(canonical(result));
      const round=(this.db.query("SELECT COALESCE(SUM(result_bytes),0) AS n FROM agent_tool_calls WHERE run_id=? AND generation=?").get(run.run_id,run.generation) as {n:number}).n;
      const total=(this.db.query("SELECT tool_output_bytes FROM agent_activations WHERE activation_id=?").get(run.activation_id) as {tool_output_bytes:number}).tool_output_bytes;
      if(round+bytes>policy.tool_output_bytes||total+bytes>policy.total_tool_output_bytes)fail("agent_tool_output_budget");
      const r=object(result),wire=sha(canonical({data_class:r.dataClass,value:r.value}));
      const updated=this.db.query("UPDATE agent_tool_calls SET state='succeeded',native_json=?,result_sha256=?,result_bytes=?,wire_result_sha256=? WHERE tool_id=? AND run_id=? AND generation=? AND state='reserved'").run(canonical(native),sha(canonical(result)),bytes,wire,id,run.run_id,run.generation).changes;
      if(updated!==1)fail("agent_tool_state_conflict");this.db.query("UPDATE agent_activations SET tool_output_bytes=tool_output_bytes+? WHERE activation_id=?").run(bytes,run.activation_id);
    }).immediate();
  }
  rejectTool(run:SupervisorRun,id:string):void{this.db.query("UPDATE agent_tool_calls SET state='arguments_rejected' WHERE tool_id=? AND run_id=? AND generation=? AND state='reserved'").run(id,run.run_id,run.generation);}
  verifyNativeTools(run:SupervisorRun,workerId:string|null,native:{threadId:string;turnId:string},receipts:Record<string,any>[]):void{
    const rows=this.db.query(`SELECT tool,argument_sha256,native_json,wire_result_sha256 FROM agent_tool_calls WHERE run_id=? AND generation=? AND ${workerId?"worker_id=?":"worker_id IS NULL"} AND state='succeeded'`).all(run.run_id,run.generation,...(workerId?[workerId]:[])) as any[];
    if(!rows.length||workerId===null&&(rows.length!==1||rows[0].tool!=="tcr_delegate"))fail("native_tool_graph_missing");
    for(const row of rows){const ids=JSON.parse(row.native_json);if(ids.thread_id!==native.threadId||ids.turn_id!==native.turnId)fail("native_tool_graph_identity_mismatch");
      const match=receipts.find(t=>t.callId===ids.call_id&&t.threadId===native.threadId&&t.turnId===native.turnId&&t.tool===row.tool&&t.status==="succeeded");
      if(!match||match.argumentSha256!==row.argument_sha256||match.resultSha256!==row.wire_result_sha256)fail("native_tool_graph_digest_mismatch");
    }
  }
  evidence(run:SupervisorRun,workerId:string,ref:string,receipt:Record<string,unknown>):void{
    this.db.transaction(()=>{this.assertActive(run);str(ref);const body=canonical(receipt);if(Buffer.byteLength(body)>512*1024)fail("ptc_receipt_budget");
      const old=this.db.query("SELECT body FROM agent_evidence WHERE evidence_ref=?").get(ref) as {body:string}|null;
      if(old&&old.body!==body)fail("evidence_reference_conflict");
      this.db.query("INSERT OR IGNORE INTO agent_evidence VALUES(?,?,?,?,?)").run(ref,run.run_id,run.generation,workerId,body);
    }).immediate();
  }
  evidenceRefs(run:SupervisorRun,workerId?:string):string[]{return(this.db.query(`SELECT evidence_ref FROM agent_evidence WHERE run_id=? AND generation=? ${workerId?"AND worker_id=?":""} ORDER BY evidence_ref`).all(run.run_id,run.generation,...(workerId?[workerId]:[])) as {evidence_ref:string}[]).map(r=>r.evidence_ref);}
  recordObservation(run:SupervisorRun,name:string,body:unknown):void{
    const current=this.run(run.run_id);if(current.generation!==run.generation||current.lease_token!==run.lease_token)fail("agent_observation_fenced");this.event(str(name,128),run,body);
  }
  recordRuntimeUpdate(daemonId:string,body:Record<string,unknown>):void{
    this.requireInitialized();str(daemonId,128);
    if(this.activations(daemonId).length===0)fail("agent_active_admission_required");
    keys(object(body),["root","activation_ids","status","checked_at","latest_check_succeeded","stale","selection","update_failure","adoption_error"]);
    if(Buffer.byteLength(canonical(body))>16384)fail("runtime_observation_budget");
    this.event("runtime_update_observed",null,{...body,daemon_id:daemonId});
  }
  rememberSnapshot(snapshot:SupervisorSnapshot):void{
    const{snapshot_sha256,...body}=snapshot;if(sha(canonical(body))!==snapshot_sha256)fail("snapshot_changed");
    this.db.query("INSERT OR IGNORE INTO agent_snapshots VALUES(?,?)").run(snapshot_sha256,canonical(snapshot));
  }
  reserveExternalScore(run:SupervisorRun,packetHandle:string):void{
    this.db.transaction(()=>{this.assertActive(run);const policy=this.activation(run.activation_id).policy;
      const packet=policy.content.prepared_packets.find(p=>p.packet_handle===packetHandle&&p.attempt_budget===1);if(!packet)fail("fresh_packet_not_admitted");
      if(this.db.query("SELECT packet_sha256 FROM agent_external_attempts WHERE activation_id=? AND packet_sha256=?").get(run.activation_id,packet.packet_sha256))fail("external_packet_attempt_spent");
      const used=(this.db.query("SELECT COUNT(*) AS n FROM agent_events WHERE run_id=? AND generation=? AND event='external_score_reserved'").get(run.run_id,run.generation) as {n:number}).n;
      const total=(this.db.query("SELECT external_calls FROM agent_activations WHERE activation_id=?").get(run.activation_id) as {external_calls:number}).external_calls;
      if(used>=policy.external_score_max_calls||total>=policy.total_external_score_calls)fail("agent_external_score_budget");
      this.db.query("INSERT INTO agent_external_attempts VALUES(?,?,?,?,?,?)").run(run.activation_id,packet.packet_sha256,packetHandle,run.run_id,run.generation,Date.now());
      this.db.query("UPDATE agent_activations SET external_calls=external_calls+1 WHERE activation_id=?").run(run.activation_id);this.event("external_score_reserved",run,{packet_handle:packetHandle,packet_sha256:packet.packet_sha256,automatic_retry:false});
    }).immediate();
  }
  openSession(activationId:string,identity:Record<string,unknown>,now=Date.now()):string{
    const previous=this.db.query("SELECT epoch_id FROM agent_sessions WHERE activation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(str(activationId)) as {epoch_id:string}|null;
    const epoch="agent_epoch_"+randomUUID();const body=canonical({...identity,_observer_host:sha(hostname())});if(Buffer.byteLength(body)>8192)fail("agent_session_identity_budget");
    this.db.query("INSERT INTO agent_sessions(epoch_id,activation_id,identity_json,previous_epoch_id,created_at) VALUES(?,?,?,?,?)").run(epoch,activationId,body,previous?.epoch_id??null,now);
    this.event("session_epoch_opened",null,{epoch_id:epoch,activation_id:activationId,previous_epoch_id:previous?.epoch_id??null,native_resume_claimed:false},now);return epoch;
  }
  closeSession(epochId:string,receipt:Record<string,unknown>,now=Date.now()):void{
    const body=canonical(receipt);if(Buffer.byteLength(body)>8192)fail("agent_session_close_budget");
    if(receipt.ownedProcessClosed!==true||receipt.ownedProcessGroupClosed!==true){this.sessionCloseFailed(epochId,"supervisor_group_cleanup_unverified",now);fail("supervisor_group_cleanup_unverified");}
    const changed=this.db.query("UPDATE agent_sessions SET close_json=?,closed_at=? WHERE epoch_id=? AND closed_at IS NULL").run(body,now,str(epochId)).changes;
    if(changed)this.event("session_closed_observation",null,{epoch_id:epochId,reason:receipt.reason??null,receipt_sha256:sha(body),proposal_rewritten:false},now);
  }
  sessionCloseFailed(epochId:string,error:string,now=Date.now()):void{
    str(epochId);str(error,128);
    this.db.query("UPDATE agent_sessions SET close_error=? WHERE epoch_id=?").run(error,epochId);
    this.event("session_cleanup_unverified",null,{epoch_id:epochId,error,capacity_retained:true,proposal_rewritten:false},now);
  }
  reconcileSupervisorGroups(daemonId:string):number{
    const rows=this.db.query("SELECT s.epoch_id,s.identity_json FROM agent_sessions s JOIN agent_activations a ON a.activation_id=s.activation_id WHERE a.daemon_id=? AND s.closed_at IS NULL ORDER BY s.created_at LIMIT 32").all(str(daemonId)) as {epoch_id:string;identity_json:string}[];
    let released=0;
    for(const row of rows){const identity=JSON.parse(row.identity_json),pid=identity.pid;if(identity._observer_host!==sha(hostname())||!Number.isSafeInteger(pid)||pid<2)continue;
      try{process.kill(-pid,0);}catch(error:any){if(error?.code!=="ESRCH")continue;
        const observed={schema_version:"task-checkpoint-record.process-group-observation.v1",pid,process_group_absent:true,observed_at:new Date().toISOString(),native_outcome:"unknown",host_handlers_settled:"unavailable"};
        released+=this.db.query("UPDATE agent_sessions SET close_json=?,closed_at=?,close_error=COALESCE(close_error,'process_exit_observed_without_runtime_receipt') WHERE epoch_id=? AND closed_at IS NULL").run(canonical(observed),Date.now(),row.epoch_id).changes;
      }
    }return released;
  }
  assertResidentAdmission(activationId:string,maxResidentSessions:number):void{
    integer(maxResidentSessions,1,32);const activation=this.activation(activationId);
    this.reconcileSupervisorGroups(activation.daemon_id);
    if(this.db.query("SELECT epoch_id FROM agent_sessions WHERE activation_id=? AND closed_at IS NULL LIMIT 1").get(activationId))fail("supervisor_previous_group_unreconciled");
    const count=(this.db.query("SELECT COUNT(*) AS n FROM agent_sessions s JOIN agent_activations a ON a.activation_id=s.activation_id WHERE a.daemon_id=? AND s.closed_at IS NULL").get(activation.daemon_id) as {n:number}).n;
    if(count>=maxResidentSessions)fail("supervisor_resident_capacity_unreconciled");
  }
  attachSessionRound(run:SupervisorRun,epochId:string):void{this.assertActive(run);this.db.query("INSERT OR IGNORE INTO agent_session_rounds VALUES(?,?,?)").run(str(epochId),run.run_id,run.generation);}
  sessionObservations(runId:string):Record<string,unknown>[]{
    return(this.db.query("SELECT s.epoch_id,s.close_json,s.closed_at,s.close_error,r.generation FROM agent_sessions s JOIN agent_session_rounds r ON r.epoch_id=s.epoch_id WHERE r.run_id=? ORDER BY r.generation,s.created_at").all(runId) as any[])
      .map(row=>({epoch_id:row.epoch_id,generation:row.generation,closed_at:row.closed_at,close_error:row.close_error,close:row.close_json?JSON.parse(row.close_json):null}));
  }
  finish(run:SupervisorRun,reduction:SupervisorReduction,now=Date.now()):Record<string,unknown>{
    return this.db.transaction(()=>{this.assertActive(run,now);
      const workers=this.db.query("SELECT worker_id,task_key,state,call_id,result_json FROM agent_workers WHERE run_id=? AND generation=? ORDER BY rowid").all(run.run_id,run.generation) as any[];
      if(!workers.length||workers.some(w=>w.state!=="succeeded"))fail("incomplete_worker_round");
      const natives=this.db.query("SELECT call_id,role,worker_id,state,native_json FROM agent_model_calls WHERE run_id=? AND generation=? ORDER BY rowid").all(run.run_id,run.generation) as any[];
      if(natives.length!==workers.length+1||natives.some(n=>n.state!=="completed"))fail("incomplete_native_receipts");
      const allowed=new Set(this.evidenceRefs(run));for(const item of [...reduction.findings,...reduction.next_actions])if(!item.evidence_refs.length||item.evidence_refs.some(id=>!allowed.has(id)))fail("proposal_evidence_outside_round");
      const snapshot=this.snapshot(run.snapshot_sha256),proposalId="agent_proposal_"+sha(canonical([run.run_id,run.generation]));
      const proposal={schema_version:"task-checkpoint-record.supervisor-proposal.v1",proposal_id:proposalId,run_id:run.run_id,generation:run.generation,task_id:snapshot.task_id,binding_id:snapshot.binding_id,window_id:run.window_id,snapshot_sha256:run.snapshot_sha256,policy_sha256:run.policy_sha256,
        formal_owner_checkpoint:false,task_acceptance:false,coverage:snapshot.coverage,reduction,workers:workers.map(w=>({...w,result:JSON.parse(w.result_json),result_json:undefined})),
        native_calls:natives.map(n=>({...n,native:JSON.parse(n.native_json),native_json:undefined})),evidence_refs:[...allowed],created_at:new Date(now).toISOString(),deeplink:this.base.link("agent-proposals",proposalId)};
      const body=JSON.stringify(proposal);if(Buffer.byteLength(body)>512*1024)fail("proposal_budget");
      this.db.query("INSERT INTO agent_proposals VALUES(?,?,?,?,?,?)").run(proposalId,run.run_id,run.generation,run.snapshot_sha256,body,now);
      this.db.query("UPDATE agent_runs SET state='succeeded',phase='proposal_persisted',finished_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=?").run(now,run.run_id);
      this.db.query("UPDATE agent_attempts SET state='succeeded',finished_at=? WHERE run_id=? AND generation=?").run(now,run.run_id,run.generation);this.event("proposal_persisted",run,{proposal_id:proposalId},now);return JSON.parse(body);
    }).immediate();
  }
  fail(run:SupervisorRun,code:string,now=Date.now()):void{
    this.db.transaction(()=>{
      const current=this.run(run.run_id);if(current.generation!==run.generation||current.lease_token!==run.lease_token||current.state!=="running")return;
      const state=current.cancel_requested?"cancelled":"failed";
      this.db.query("UPDATE agent_runs SET state=?,phase=?,error_code=?,finished_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=?").run(state,state,str(code,128),now,run.run_id);
      this.db.query("UPDATE agent_attempts SET state=?,finished_at=? WHERE run_id=? AND generation=?").run(state,now,run.run_id,run.generation);
      this.db.query("UPDATE agent_model_calls SET state='unknown',error_code=? WHERE run_id=? AND generation=? AND state IN ('reserved','started')").run(code,run.run_id,run.generation);
      this.db.query("UPDATE agent_workers SET state=?,error_code=? WHERE run_id=? AND generation=? AND state IN ('queued','running')").run(state,code,run.run_id,run.generation);this.event("attempt_failed",run,{code,automatic_retry:false},now);
    }).immediate();
  }
  retry(runId:string):boolean{
    this.requireInitialized();const selected=this.run(runId);this.reconcileWorkerGroups(selected.activation_id);
    return this.db.transaction(()=>{const run=this.run(runId),activation=this.activation(run.activation_id);
      if(!activation.active||run.attempts>=activation.policy.max_attempts)fail("attempt_budget_or_activation");
      if(!["failed","interrupted","cancelled"].includes(run.state))fail("run_not_retryable");
      if(this.db.query("SELECT w.worker_id FROM agent_workers w JOIN agent_runs r ON r.run_id=w.run_id WHERE r.activation_id=? AND w.call_id IS NOT NULL AND w.process_closed=0 LIMIT 1").get(run.activation_id))fail("unknown_worker_cleanup_requires_reconciliation");
      this.db.query("UPDATE agent_runs SET state='queued',phase='explicit_retry',cancel_requested=0,error_code=NULL,finished_at=NULL WHERE run_id=?").run(runId);this.event("explicit_retry_requested",run,{prior_state:run.state});return true;
    }).immediate();
  }
  cancel(runId:string,now=Date.now()):boolean{
    this.requireInitialized();return this.db.transaction(()=>{const run=this.run(runId);if(!["queued","running"].includes(run.state))return false;
      this.db.query("UPDATE agent_runs SET cancel_requested=1,state=?,phase=?,finished_at=? WHERE run_id=?").run(run.state==="queued"?"cancelled":"running",run.state==="queued"?"cancelled":"cancel_requested",run.state==="queued"?now:null,runId);this.event("cancel_requested",run,{},now);return true;
    }).immediate();
  }
  status():Record<string,unknown>{
    if(!this.initialized())return{schema_version:"task-checkpoint-record.supervisor-status.v1",initialized:false};
    return{schema_version:"task-checkpoint-record.supervisor-status.v1",initialized:true,
      activations:this.db.query("SELECT a.activation_id,a.binding_id,a.task_id,a.daemon_id,a.active,a.rounds_reserved,a.native_calls,a.tool_calls,a.tool_output_bytes,a.external_calls,(SELECT COUNT(*) FROM agent_workers w JOIN agent_runs r ON r.run_id=w.run_id WHERE r.activation_id=a.activation_id AND w.call_id IS NOT NULL AND w.process_closed=0 AND w.state!='running') AS unknown_worker_groups FROM agent_activations a ORDER BY a.rowid DESC LIMIT 100").all(),
      runs:this.db.query("SELECT state,COUNT(*) AS count FROM agent_runs GROUP BY state").all(),wakes:this.db.query("SELECT state,COUNT(*) AS count FROM agent_wakes GROUP BY state").all(),
      services:this.db.query("SELECT daemon_id,pid,state,heartbeat,stop_requested FROM agent_services ORDER BY daemon_id LIMIT 32").all(),
      runtime_updates:(this.db.query("SELECT seq,created_at,body FROM agent_events WHERE seq IN (SELECT MAX(seq) FROM agent_events WHERE event='runtime_update_observed' GROUP BY json_extract(body,'$.daemon_id'),json_extract(body,'$.root')) ORDER BY seq DESC LIMIT 32").all() as {seq:number;created_at:number;body:string}[])
        .map(row=>({seq:row.seq,observed_at:new Date(row.created_at).toISOString(),...JSON.parse(row.body)}))};
  }
  jobs(options:{activation_id?:string;state?:string;limit?:number;offset?:number}={}):Record<string,unknown>{
    this.requireInitialized();keys(object(options),["activation_id","state","limit","offset"]);const where:string[]=[],args:string[]=[];
    if(options.activation_id){where.push("activation_id=?");args.push(str(options.activation_id));}if(options.state){where.push("state=?");args.push(str(options.state));}
    const limit=integer(options.limit??20,1,100),offset=integer(options.offset??0,0,10000);
    const rows=this.db.query(`SELECT run_id,activation_id,window_id,snapshot_sha256,state,phase,generation,attempts,model_started,cancel_requested,error_code,created_at,finished_at FROM agent_runs ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args,limit+1,offset);
    return{schema_version:"task-checkpoint-record.agent-jobs.v1",items:rows.slice(0,limit).map((r:any)=>({...r,deeplink:this.base.link("agent-runs",r.run_id)})),next_offset:rows.length>limit?offset+limit:null};
  }
  verify(runId:string):Record<string,unknown>{
    const run=this.run(runId),snapshot=this.snapshot(run.snapshot_sha256),proposals=this.db.query("SELECT proposal_id,body FROM agent_proposals WHERE run_id=? ORDER BY generation").all(runId) as {proposal_id:string;body:string}[];
    const count=(this.db.query("SELECT COUNT(*) AS n FROM agent_evidence WHERE run_id=?").get(runId) as {n:number}).n;
    return{schema_version:"task-checkpoint-record.agent-verification.v1",run_id:runId,state:run.state,snapshot_digest_verified:true,task_id:snapshot.task_id,evidence_count:count,proposal_ids:proposals.map(p=>p.proposal_id),proposal_deeplinks:proposals.map(p=>this.base.link("agent-proposals",p.proposal_id)),session_observations:this.sessionObservations(runId),validation_as_of:"Native outcome was checked at proposal commit; later session observations are separate and immutable proposals are not rewritten.",formal_owner_checkpoint:false,task_acceptance:false,source_bytes_replayed:false};
  }
  resolve(link:string,fields?:string[]):Record<string,unknown>{
    this.requireInitialized();let url:URL;try{url=new URL(str(link,2048));}catch{return fail("invalid_agent_deeplink");}
    if(url.protocol!=="tcr:"||url.hostname!==this.base.storeId||url.username||url.password||url.port||url.search||url.hash)fail("foreign_agent_deeplink");
    const parts=url.pathname.split("/");if(parts.length!==3)fail("invalid_agent_deeplink");
    let id:string;try{id=str(decodeURIComponent(parts[2]));}catch{return fail("invalid_agent_deeplink");}
    const kind=parts[1];let body:Record<string,any>,allowed:string[],defaults:string[];
    if(kind==="agent-proposals"){
      const row=this.db.query("SELECT body FROM agent_proposals WHERE proposal_id=?").get(id) as {body:string}|null;if(!row)fail("agent_deeplink_not_found");body=JSON.parse(row.body);
      body.evidence_deeplinks=body.evidence_refs.map((ref:string)=>this.base.link("agent-evidence",ref));
      allowed=["proposal_id","run_id","generation","task_id","binding_id","window_id","snapshot_sha256","policy_sha256","formal_owner_checkpoint","task_acceptance","coverage","reduction.summary","reduction.continuity_context","reduction.findings","reduction.next_actions","reduction.recommendation","workers","native_calls","evidence_refs","evidence_deeplinks","created_at","deeplink"];
      defaults=["proposal_id","task_id","window_id","reduction.summary","reduction.continuity_context","reduction.recommendation","evidence_deeplinks","formal_owner_checkpoint","task_acceptance"];
    }else if(kind==="agent-evidence"){
      const row=this.db.query("SELECT run_id,generation,worker_id,body FROM agent_evidence WHERE evidence_ref=?").get(id) as any;if(!row)fail("agent_deeplink_not_found");
      body={...JSON.parse(row.body),run_id:row.run_id,generation:row.generation,worker_id:row.worker_id,deeplink:this.base.link(kind,id)};
      allowed=["evidence_ref","run_id","generation","worker_id","activation_id","binding_id","task_id","window_id","snapshot_sha256","thread_id","turn_id","call_id","tool","status","error_code","arguments_sha256","result_sha256","record_handles","source_refs","external_attempt_reserved","scoring_config_sha256","deeplink"];
      defaults=["evidence_ref","run_id","worker_id","tool","status","arguments_sha256","result_sha256","record_handles","deeplink"];
    }else if(kind==="agent-runs"){
      const run=this.run(id),proposalRows=this.db.query("SELECT proposal_id FROM agent_proposals WHERE run_id=? ORDER BY generation").all(id) as {proposal_id:string}[];
      body={...run,proposal_deeplinks:proposalRows.map(p=>this.base.link("agent-proposals",p.proposal_id)),deeplink:this.base.link(kind,id)};
      allowed=["run_id","activation_id","window_id","snapshot_sha256","policy_sha256","state","phase","generation","attempts","model_started","cancel_requested","error_code","created_at","finished_at","proposal_deeplinks","deeplink"];
      defaults=["run_id","activation_id","window_id","state","phase","generation","error_code","proposal_deeplinks","deeplink"];
    }else return fail("unknown_agent_deeplink_kind");
    const selected=fields??defaults;if(!Array.isArray(selected)||selected.length<1||selected.length>24||new Set(selected).size!==selected.length||selected.some(f=>!allowed.includes(f)))fail("unknown_agent_projection_field");
    const item:Record<string,unknown>={};for(const field of selected){let value:any=body;for(const part of field.split("."))value=value?.[part];item[field]=value??null;}
    const result={schema_version:"task-checkpoint-record.agent-resolution.v1",store_id:this.base.storeId,kind,item,source_bytes_read:false};
    if(Buffer.byteLength(JSON.stringify(result))>512*1024)fail("agent_resolution_budget");return result;
  }
  cachedReview(input:{binding_id:string;turn_id:string|null;window_id:string;consume_strict?:boolean},now=Date.now()):Record<string,unknown>{
    if(!this.initialized())return{decision:"unavailable",reason:"not_activated"};
    return this.db.transaction(()=>{
      const active=this.db.query("SELECT activation_id FROM agent_activations WHERE binding_id=? AND active=1").get(str(input.binding_id)) as {activation_id:string}|null;
      if(!active)return{decision:"unavailable",reason:"not_activated"};const activation=this.activation(active.activation_id);
      const row=this.db.query("SELECT p.body,p.created_at FROM agent_proposals p JOIN agent_runs r ON r.run_id=p.run_id WHERE r.activation_id=? AND r.state='succeeded' ORDER BY p.created_at DESC LIMIT 1").get(active.activation_id) as {body:string;created_at:number}|null;
      if(!row)return{decision:"unavailable",reason:"no_completed_review",pending_model_never_blocks:true};
      const proposal=JSON.parse(row.body),snapshot=this.snapshot(proposal.snapshot_sha256),current=this.db.query("SELECT binding_id,hook_turn_id,body FROM windows WHERE window_id=?").get(str(input.window_id)) as any;
      const prior=this.db.query("SELECT body FROM windows WHERE window_id=?").get(snapshot.window_id) as {body:string};
      const anomalous=this.sessionObservations(proposal.run_id).some((o:any)=>o.close_error!==null||o.close&&!['owner_closed','cancelled'].includes(o.close.reason));
      const fresh=!anomalous&&!!current&&current.binding_id===input.binding_id&&input.turn_id!==null&&current.hook_turn_id===input.turn_id&&snapshot.task_native.hook_turn_id===input.turn_id&&now-row.created_at>=0&&now-row.created_at<=activation.policy.stop.max_age_ms&&canonical(JSON.parse(current.body).source_bounds)===canonical(JSON.parse(prior.body).source_bounds);
      const advisory={decision:"advisory",proposal_id:proposal.proposal_id,fresh,formal_owner_checkpoint:false,task_acceptance:false};
      if(!fresh||activation.policy.stop.mode!=="strict_once"||!input.consume_strict||proposal.reduction.recommendation!=="needs_attention"||!proposal.reduction.next_actions.length)return advisory;
      const inserted=this.db.query("INSERT OR IGNORE INTO agent_stop_guards VALUES(?,?,?,?)").run(active.activation_id,input.turn_id,proposal.proposal_id,now).changes===1;
      return inserted?{...advisory,decision:"block_once",reason:`Review the cached checkpoint proposal ${proposal.proposal_id}; this turn receives at most one continuation request.`}:advisory;
    }).immediate();
  }
  registerService(daemonId:string,token:string,now=Date.now(),waitingForAck=false):void{
    this.requireInitialized();this.db.transaction(()=>{str(daemonId);str(token);const old=this.db.query("SELECT heartbeat,state FROM agent_services WHERE daemon_id=?").get(daemonId) as any;
      if(["running","waiting_for_ack"].includes(old?.state)&&old.heartbeat>now-5000)fail("agent_daemon_already_running");
      this.db.query("INSERT INTO agent_services VALUES(?,?,?,?,?,0) ON CONFLICT(daemon_id) DO UPDATE SET token=excluded.token,pid=excluded.pid,heartbeat=excluded.heartbeat,state=excluded.state,stop_requested=0").run(daemonId,token,process.pid,now,waitingForAck?"waiting_for_ack":"running");
    }).immediate();
  }
  heartbeat(daemonId:string,token:string,now=Date.now()):boolean{return this.db.query("UPDATE agent_services SET heartbeat=? WHERE daemon_id=? AND token=? AND state IN ('running','waiting_for_ack') AND stop_requested=0").run(now,daemonId,token).changes===1;}
  acknowledgeService(daemonId:string,token:string):boolean{return this.db.query("UPDATE agent_services SET state='running' WHERE daemon_id=? AND token=? AND state='waiting_for_ack' AND stop_requested=0").run(daemonId,token).changes===1;}
  requestStop(daemonId:string):boolean{if(!this.initialized())return false;return this.db.query("UPDATE agent_services SET stop_requested=1 WHERE daemon_id=? AND state IN ('running','waiting_for_ack')").run(str(daemonId)).changes===1;}
  serviceStopped(daemonId:string,token:string):void{this.db.query("UPDATE agent_services SET state='stopped',heartbeat=? WHERE daemon_id=? AND token=?").run(Date.now(),daemonId,token);}
}

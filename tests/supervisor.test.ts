import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Store } from "../src/store.ts";
import { SupervisorStore } from "../src/supervisor-store.ts";
import { SupervisorDaemon, type SupervisorPtcFactory, type SupervisorRuntimeFactory } from "../src/supervisor.ts";
import { createSupervisorPolicy } from "../src/supervisor-policy.ts";
import { canonical, fingerprint, openRegular, sha, TcrError } from "../src/security.ts";
import { runHelper, runScoringHelper, workerOptions } from "../src/worker.ts";
import type { AgentCloseReceipt, AgentIdentity, AgentSession, AgentTool, AgentTurnOptions, AgentTurnResult } from "../src/agent-runtime.ts";
import type { SupervisorActivation, SupervisorPolicy, WorkerReport } from "../src/supervisor-types.ts";
import type { NormalizedRecord } from "../src/types.ts";

const roots:string[]=[],stores:Store[]=[],daemons:SupervisorDaemon[]=[];
const helper=fileURLToPath(new URL("./fixture-helper.ts",import.meta.url));
afterEach(async()=>{for(const d of daemons.splice(0))try{await d.close();}catch{}for(const s of stores.splice(0))s.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(overrides:Partial<SupervisorPolicy>={},queued=false){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-supervisor-")));roots.push(root);const sourceRoot=join(root,"sources");mkdirSync(sourceRoot,{mode:0o700});
  const source=join(sourceRoot,"raw.jsonl"),line=JSON.stringify({type:"message",entry_id:"synthetic-entry",text:"SYNTHETIC_BODY"})+"\n";writeFileSync(source,line,{mode:0o600});
  const fixed=join(root,"fixed.bunfig.toml");writeFileSync(fixed,"# synthetic owned config\n",{mode:0o600});
  const runtime_config={recorder:{helper_command:[process.execPath,"--no-env-file","--no-install","--config="+fixed,helper],concurrency:2,max_jobs:64,timeout_ms:2000,lease_ms:4000,page_bytes:16384,page_limit:100,stdout_bytes:1048576}};
  const base=new Store(join(root,"state"),{initialize:true});stores.push(base);const store=new SupervisorStore(base);
  const binding=base.bind({schema_version:"task-checkpoint-record.binding.v1",binding_id:"binding",task_id:"task",project_id:null,client:"codex",profile:"synthetic",runtime_home:null,native_session_id:"master-session",role:"master",source_root:sourceRoot,sources:[{source_id:"raw",path:source,format:"codex",start_at:"beginning"}]});
  const window=base.enqueue(binding,{hook_event_name:"PreCompact",native_session_id:"master-session",native_turn_id:"master-turn",transcript_path:source,input_sha256:sha("hook-1"),delivery_id:null});
  if(!queued){
    const job=base.claim("fixture")!,fd=openRegular(source),record:NormalizedRecord={record_id:"synthetic-record",client:"codex",kind:"message",timestamp:null,native:{session_id:null,turn_id:null,entry_id:null,parent_entry_id:null,trajectory_id:null,step_id:null},source:{uri:pathToFileURL(source).href,format:"codex",version:null,offset:0,length:Buffer.byteLength(line),sha256:sha(line),json_pointer:""},labels:[],text_available:true};
    base.finishPage(job,{schema_version:"ultrafast-atif.page.v1",records:[record],next_offset:Buffer.byteLength(line),eof:true,incomplete_tail:false,omissions:[]},0,Buffer.byteLength(line),canonical(fingerprint(fd,Buffer.byteLength(line))),true);closeSync(fd);
  }
  const policy=createSupervisorPolicy({daemon_id:"daemon",config_sha256:sha(canonical(runtime_config)),...overrides});
  const activate=()=>store.activate({activation_id:"activation",binding_id:binding.binding_id,policy,runtime_config,include_existing_windows:true});
  return{root,base,store,binding,window,policy,runtime_config,source,activate};
}
function closeReceipt(identity:AgentIdentity,turns=1):AgentCloseReceipt{return{schemaVersion:"task-checkpoint.agent-close.v1",native:{threadId:identity.threadId,sessionId:identity.sessionId},pid:identity.pid,ownedProcessClosed:true,ownedProcessGroupClosed:true,hostHandlersSettled:true,turnsStarted:turns,reason:"owner_closed"};}
function turnResult<T>(identity:AgentIdentity,turnId:string,output:T):AgentTurnResult<T>{return{schemaVersion:"task-checkpoint.agent-turn.v1",output,native:{threadId:identity.threadId,sessionId:identity.sessionId,turnId},requested:identity.requested,observed:identity.observed,input:{dataClass:"metadata_only",sha256:sha("synthetic"),bytes:9},usage:null,toolReceipts:[],runtime:{protocolVersion:"codex-0.157.1",pid:identity.pid,sessionOpen:true,turnIndex:1,elapsedMs:1,nativeCompactions:0,toolPolicy:"restricted-native-and-explicit-host-allowlist"}};}
function fakeRuntime(options:{workers?:number;holdWorkers?:boolean;badEvidence?:boolean;badNativeGraph?:boolean;recommendAttention?:boolean}={}){
  let supervisors=0,workers=0,active=0,peak=0,closed=0;const observedThreads:string[]=[];
  const identity=(activation:SupervisorActivation,worker:boolean,id:number):AgentIdentity=>({threadId:(worker?"worker-thread-":"supervisor-thread-")+id,sessionId:(worker?"worker-session-":"supervisor-session-")+id,pid:10000+id,role:worker?"semantic-worker":"supervisor",requested:activation.policy[worker?"worker":"supervisor"],observed:activation.policy[worker?"worker":"supervisor"],protocolVersion:"codex-0.157.1"});
  const factory:SupervisorRuntimeFactory={
    async createSupervisor(activation,initialTools){
      const id=identity(activation,false,++supervisors);let turns=0,ended=false;
      let resolveClose!:(receipt:AgentCloseReceipt)=>void;const closedPromise=new Promise<AgentCloseReceipt>(resolve=>{resolveClose=resolve;});
      const session:AgentSession={identity:id,closed:closedPromise,assertHealthy(){if(ended)throw new TcrError("synthetic_closed");},async runTurn<T>(turn:AgentTurnOptions<T>){
        const turnId="supervisor-turn-"+(++turns);observedThreads.push(id.threadId);turn.onStarted?.({threadId:id.threadId,sessionId:id.sessionId,turnId});
        const tool=(turn.tools??initialTools)[0];const tasks=Array.from({length:options.workers??2},(_,i)=>({task_key:"worker-"+i,objective:"Inspect this bounded source selection."}));
        const args=tool.validateArguments({tasks});const reply=await tool.execute(args,{threadId:id.threadId,turnId,callId:"delegate-"+turns,signal:turn.signal??new AbortController().signal});
        const evidence=(reply.value as any).workers.map((w:any)=>w.evidence_refs[0]);
        const output=turn.validateOutput({summary:"Bounded workers completed.",continuity_context:"Continue using the retained source handles.",findings:[{category:"progress",statement:"Each worker inspected scoped evidence.",evidence_refs:evidence.slice(0,32)}],next_actions:options.recommendAttention?[{action_id:"owner-review",reason:"Inspect the proposal before sealing.",evidence_refs:[evidence[0]]}]:[],recommendation:options.recommendAttention?"needs_attention":"continue"});
        return{...turnResult(id,turnId,output),toolReceipts:[{callId:"delegate-"+turns,tool:tool.name,threadId:id.threadId,turnId,argumentSha256:sha(canonical({tasks})),argumentBytes:Buffer.byteLength(canonical({tasks})),resultSha256:sha(canonical({data_class:reply.dataClass,value:reply.value})),resultBytes:Buffer.byteLength(canonical(reply)),dataClass:reply.dataClass,status:"succeeded"}]};
      },async close(){if(!ended){closed++;ended=true;}const receipt=closeReceipt(id,turns);resolveClose(receipt);return receipt;},async cancel(){return this.close();}};return session;
    },
    async runWorker(activation,task,tools,turn){
      const id=identity(activation,true,++workers),turnId="worker-turn-"+workers;active++;peak=Math.max(peak,active);
      try{
        turn.onStarted?.({threadId:id.threadId,sessionId:id.sessionId,turnId});
        if(options.holdWorkers)await new Promise<void>((_resolve,reject)=>{const stop=()=>reject(Object.assign(new TcrError("synthetic_cancelled"),{native:{threadId:id.threadId,turnId},closeReceipt:closeReceipt(id)}));if(turn.signal?.aborted)stop();else turn.signal?.addEventListener("abort",stop,{once:true});});
        await Bun.sleep(5);
        const tool=tools[0],callId="query-"+id.threadId;const result=await tool.execute(tool.validateArguments({}),{threadId:id.threadId,turnId,callId,signal:turn.signal??new AbortController().signal});
        const ref=(result.value as any).evidence_ref;
        const report=turn.validateOutput({task_key:task.task_key,summary:"Observed bounded metadata.",claims:[{claim_id:"observed",statement:"The selected record is present.",evidence_refs:[options.badEvidence?"not-issued":ref]}],omissions:[]});
        return{...turnResult(id,turnId,report),toolReceipts:[{callId,tool:tool.name,threadId:options.badNativeGraph?"borrowed-thread":id.threadId,turnId,argumentSha256:sha("{}"),argumentBytes:2,resultSha256:sha(canonical({data_class:result.dataClass,value:result.value})),resultBytes:Buffer.byteLength(canonical(result)),dataClass:result.dataClass,status:"succeeded"}],close:closeReceipt(id)};
      }finally{active--;}
    }
  };
  return{factory,status:()=>({supervisors,workers,active,peak,closed,observedThreads})};
}
const fakePtc:SupervisorPtcFactory=context=>({tools:[{name:"tcr_query",description:"Synthetic scoped metadata query",inputSchema:{type:"object",additionalProperties:false},validateArguments:v=>v,async execute(_args,native){
  context.assertActive();const ref="ptc:"+sha(context.workerId+native.threadId+native.turnId+native.callId),value={evidence_ref:ref,record_count:context.snapshot.record_refs.length};
  await context.onReceipt({schema_version:"task-checkpoint.ptc-receipt.v1",evidence_ref:ref,activation_id:context.activation.activation_id,snapshot_sha256:context.snapshot.snapshot_sha256,binding_id:context.snapshot.binding_id,task_id:context.snapshot.task_id,window_id:context.snapshot.window_id,thread_id:native.threadId,turn_id:native.turnId,call_id:native.callId,tool:"tcr_query",sequence:1,status:"completed",error_code:null,arguments:{},arguments_sha256:sha("{}"),result:{dataClass:"metadata_only",value},result_sha256:sha(canonical(value)),record_handles:context.snapshot.record_refs.map(r=>r.handle),source_refs:[],helper:null,external_attempt_reserved:false,scoring_config_sha256:null});
  return{dataClass:"metadata_only",value};
}}]});
function daemon(s:ReturnType<typeof setup>,fake= fakeRuntime(),ptcFactory=fakePtc){const d=new SupervisorDaemon({store:s.store,daemon_id:"daemon",runtimeFactory:fake.factory,ptcFactory});daemons.push(d);return{d,fake};}

test("observation/query and unactivated wakes create no agent tables or model processes",()=>{
  const s=setup(),f=fakeRuntime();new SupervisorDaemon({store:s.store,daemon_id:"daemon",runtimeFactory:f.factory,ptcFactory:fakePtc});
  expect(s.store.status()).toMatchObject({initialized:false});expect(s.store.wake(s.binding.binding_id,s.window.window_id)).toMatchObject({accepted:false});expect(s.store.initialized()).toBe(false);expect(f.status().supervisors).toBe(0);
});
test("activation requires a live master binding and frozen exact config",()=>{
  const s=setup();expect(()=>s.store.activate({activation_id:"a",binding_id:"binding",policy:s.policy,runtime_config:{changed:true}})).toThrow("activation_config_digest_mismatch");
  s.base.unbind("binding");expect(()=>s.activate()).toThrow("activation_requires_bound_master");
});
test("two workers make scoped tool calls and produce only an intermediate persisted proposal",async()=>{
  const s=setup();s.activate();const{d,fake}=daemon(s);const result=await d.once();expect(result.state).toBe("succeeded");expect(fake.status()).toMatchObject({supervisors:1,workers:2,peak:2});
  const status=s.store.status() as any;expect(status.activations[0].native_calls).toBe(3);expect(status.activations[0].tool_calls).toBe(3);
  const proposal=JSON.parse((s.base.db.query("SELECT body FROM agent_proposals").get() as any).body);expect(proposal.formal_owner_checkpoint).toBe(false);expect(proposal.task_acceptance).toBe(false);expect(proposal.workers.length).toBe(2);expect(proposal.native_calls.length).toBe(3);expect(proposal.evidence_refs.length).toBe(2);
  expect((await d.once()).state).toBe("idle");expect(fake.status().workers).toBe(2);expect(s.store.verify(String(result.run_id))).toMatchObject({snapshot_digest_verified:true,formal_owner_checkpoint:false});
  const resolved=s.store.resolve(proposal.deeplink) as any;expect(resolved.item["reduction.continuity_context"]).toContain("source handles");
  const evidence=s.store.resolve(resolved.item.evidence_deeplinks[0]) as any;expect(evidence.item.status).toBe("completed");expect(evidence.source_bytes_read).toBe(false);
  expect(()=>s.store.resolve("https://invalid.example/secret")).toThrow("foreign_agent_deeplink");expect(()=>s.store.resolve(proposal.deeplink,["lease_token"])).toThrow("unknown_agent_projection_field");
});
test("unified daemon drains only activated binding ETL and reuses one native supervisor across two windows",async()=>{
  const s=setup({},true);s.activate();const{d,fake}=daemon(s);expect((await d.once()).state).toBe("succeeded");
  appendFileSync(s.source,'{"type":"message","entry_id":"later","text":"synthetic"}\n');
  s.base.enqueue(s.binding,{hook_event_name:"PreCompact",native_session_id:"master-session",native_turn_id:"master-turn",transcript_path:s.source,input_sha256:sha("hook-2"),delivery_id:null});
  expect((await d.once()).state).toBe("succeeded");expect(fake.status().supervisors).toBe(1);expect(fake.status().workers).toBe(4);expect(new Set(fake.status().observedThreads).size).toBe(1);
  expect((s.base.db.query("SELECT COUNT(*) AS n FROM agent_sessions").get() as any).n).toBe(1);
  appendFileSync(s.source,'{"type":"message","entry_id":"budget-stop"}\n');s.base.enqueue(s.binding,{hook_event_name:"Stop",native_session_id:"master-session",native_turn_id:"master-turn",transcript_path:s.source,input_sha256:sha("hook-3"),delivery_id:null});
  expect((await d.once()).state).toBe("idle");expect(fake.status().workers).toBe(4);expect((s.store.status() as any).wakes.some((r:any)=>r.state==="budget_exhausted")).toBe(true);
});
test("runtime maintenance waits for startup acknowledgement and never runs during an active fanout",async()=>{
  const s=setup({},true);s.activate();const f=fakeRuntime({holdWorkers:true});let checks=0;
  f.factory.beforeCycle=async()=>{checks++;return{ready:true};};const {d}=daemon(s,f);
  const before=new AbortController();await d.run(before.signal,{beforeFirstWork:async()=>{expect(checks).toBe(0);before.abort();}});
  expect(checks).toBe(0);expect(f.status().supervisors).toBe(0);
  const second=new SupervisorDaemon({store:s.store,daemon_id:"daemon",runtimeFactory:f.factory,ptcFactory:fakePtc});daemons.push(second);
  const active=new AbortController(),pending=second.once(active.signal);
  for(let i=0;i<100&&f.status().active===0;i++)await Bun.sleep(5);
  expect(f.status().active).toBeGreaterThan(0);expect(checks).toBe(1);
  await expect(second.once()).rejects.toThrow("agent_daemon_busy");expect(checks).toBe(1);
  active.abort();await pending;expect(checks).toBe(1);
});
test("idle runtime rotation links epochs and preserves consumed activation budgets",async()=>{
  const s=setup({},true);s.activate();const f=fakeRuntime();let replace=false,checks=0;
  f.factory.beforeCycle=async({rotateSessions})=>{checks++;if(replace){expect(f.status().active).toBe(0);await rotateSessions(["activation"]);replace=false;}return{ready:true};};
  const {d}=daemon(s,f);expect((await d.once()).state).toBe("succeeded");const first=(s.base.db.query("SELECT epoch_id FROM agent_sessions").get() as any).epoch_id;
  const before=(s.store.status() as any).activations[0];expect(before.rounds_reserved).toBe(1);expect(before.native_calls).toBe(3);
  appendFileSync(s.source,'{"type":"message","entry_id":"next-runtime-window"}\n');s.base.enqueue(s.binding,{hook_event_name:"PreCompact",native_session_id:"master-session",native_turn_id:"master-turn-2",transcript_path:s.source,input_sha256:sha("runtime-cycle-two"),delivery_id:null});
  replace=true;expect((await d.once()).state).toBe("succeeded");expect(checks).toBe(2);expect(f.status()).toMatchObject({supervisors:2,workers:4,closed:1});
  const epochs=s.base.db.query("SELECT epoch_id,previous_epoch_id,closed_at FROM agent_sessions ORDER BY rowid").all() as any[];
  expect(epochs).toHaveLength(2);expect(epochs[0].closed_at).not.toBeNull();expect(epochs[1].previous_epoch_id).toBe(first);
  const after=(s.store.status() as any).activations[0];expect(after.rounds_reserved).toBe(2);expect(after.native_calls).toBe(6);
});
test("runtime rotation with unknown closure retains capacity and does not consume the next round",async()=>{
  const s=setup({},true);s.activate();const f=fakeRuntime(),original=f.factory.createSupervisor;let rotate=false;
  f.factory.createSupervisor=async(...args)=>{const session=await original(...args);return{...session,close:async()=>{throw new TcrError("owned_group_unverified");}};};
  f.factory.beforeCycle=async({rotateSessions})=>{if(rotate)await rotateSessions(["activation"]);return{ready:true};};
  const {d}=daemon(s,f);expect((await d.once()).state).toBe("succeeded");rotate=true;
  await expect(d.once()).rejects.toThrow("owned_group_unverified");expect(f.status().supervisors).toBe(1);
  const epoch=s.base.db.query("SELECT close_error,closed_at FROM agent_sessions").get() as any;
  expect(epoch.close_error).toBe("owned_group_unverified");expect(epoch.closed_at).toBeNull();expect((s.store.status() as any).activations[0].native_calls).toBe(3);
});
test("unavailable qualified runtime leaves extraction and model admission unconsumed",async()=>{
  const s=setup({},true);s.activate();const f=fakeRuntime();f.factory.beforeCycle=async()=>({ready:false});const {d}=daemon(s,f);
  expect(await d.once()).toEqual({state:"runtime_unavailable",model_started:false,extracted:0});expect(f.status().supervisors).toBe(0);
  expect((s.base.status().jobs as any[])[0].state).toBe("queued");expect((s.store.status() as any).activations[0].rounds_reserved).toBe(0);
});
test("configured 32-worker fanout stays bounded and compact reply permits reduction",async()=>{
  const s=setup({max_workers:32,worker_concurrency:32,native_call_budget:33,max_rounds:1});s.activate();const{d,fake}=daemon(s,fakeRuntime({workers:32}));expect((await d.once()).state).toBe("succeeded");
  expect(fake.status().workers).toBe(32);expect(fake.status().peak).toBe(32);expect((s.store.status() as any).activations[0].native_calls).toBe(33);
  expect(()=>createSupervisorPolicy({daemon_id:"d",config_sha256:sha("{}"),max_workers:33})).toThrow();
});
test("pre-model lease recovery is permitted; model reservation recovery is interrupted and explicit",()=>{
  const s=setup();s.activate();s.store.enqueueReady();const first=s.store.claim("one","daemon",1000)!;
  expect(s.store.recoverExpired(1000+s.policy.lease_ms+1)).toBe(1);expect(s.store.run(first.run_id).state).toBe("queued");
  const second=s.store.claim("two","daemon",50000)!;s.store.reserveNative(second,"supervisor",null,50001);
  s.store.recoverExpired(50000+s.policy.lease_ms+1);expect(s.store.run(second.run_id).state).toBe("interrupted");expect(s.store.claim("three","daemon",90000)).toBeNull();
  expect(()=>s.store.assertActive(second,90000)).toThrow("agent_lease_or_activation_fenced");expect(s.store.retry(second.run_id)).toBe(true);
  const third=s.store.claim("three","daemon",90000)!;expect(third.generation).toBe(3);expect((s.store.status() as any).activations[0].native_calls).toBe(1);
});
test("cancellation interrupts active worker promises and never produces a successful proposal",async()=>{
  const s=setup();s.activate();const{d,fake}=daemon(s,fakeRuntime({holdWorkers:true}));const pending=d.once();
  for(let i=0;i<100&&fake.status().workers===0;i++)await Bun.sleep(5);const run=(s.store.jobs().items as any[])[0];expect(run.state).toBe("running");s.store.cancel(run.run_id);
  expect((await pending).state).toBe("cancelled");expect(fake.status().active).toBe(0);expect((s.base.db.query("SELECT COUNT(*) AS n FROM agent_proposals").get() as any).n).toBe(0);expect((await d.once()).state).toBe("idle");
});
test("fake evidence or cross-window receipt cannot be promoted by a model report",async()=>{
  const s=setup();s.activate();const{d}=daemon(s,fakeRuntime({badEvidence:true}));expect((await d.once()).state).toBe("failed");expect((s.base.db.query("SELECT COUNT(*) AS n FROM agent_proposals").get() as any).n).toBe(0);
});
test("borrowed native tool receipts cannot satisfy the worker evidence graph",async()=>{
  const s=setup();s.activate();const{d}=daemon(s,fakeRuntime({badNativeGraph:true}));const result=await d.once();expect(result.state).toBe("failed");expect(result.error).toBe("ptc_native_tool_receipt_mismatch");
});
test("unknown worker process closure retains capacity and blocks explicit retry until proof arrives",()=>{
  const s=setup();s.activate();s.store.enqueueReady();const run=s.store.claim("owner","daemon",1000)!;s.store.reserveNative(run,"supervisor",null,1001);
  // Lease-clock arguments are deliberately synthetic; admission uses real now.
  s.base.db.query("UPDATE agent_runs SET lease_until=? WHERE run_id=?").run(Date.now()+30000,run.run_id);
  const workers=s.store.admitFanout(run,[{task_key:"one",objective:"Observe metadata."}]);expect(s.store.claimWorker(run,workers[0].worker_id)).toBe(true);
  s.store.reserveNative(run,"worker",workers[0].worker_id);s.store.fail(run,"synthetic_process_death");
  expect(()=>s.store.retry(run.run_id)).toThrow("unknown_worker_cleanup_requires_reconciliation");
  const receipt=closeReceipt({threadId:"worker",sessionId:null,pid:12345,role:"semantic-worker",requested:s.policy.worker,observed:s.policy.worker,protocolVersion:"codex-0.157.1"});
  expect(s.store.recordWorkerClosure(run,workers[0].worker_id,receipt as any)).toBe(true);expect(s.store.retry(run.run_id)).toBe(true);
});
test("startup acknowledgment failure stops before ETL or any native turn",async()=>{
  const s=setup({},true);s.activate();const{d,fake}=daemon(s);let observed="";
  await expect(d.run(undefined,{beforeFirstWork:async()=>{observed=(s.store.status() as any).services[0].state;throw new TcrError("synthetic_ack_failed");}})).rejects.toThrow("synthetic_ack_failed");
  expect(observed).toBe("waiting_for_ack");expect((s.store.status() as any).services[0].state).toBe("stopped");expect(fake.status().supervisors).toBe(0);expect((s.base.status().jobs as any[])[0].state).toBe("queued");
});
test("rejected supervisor closure is durable, invalidates cache and retains capacity across restart",async()=>{
  const s=setup({stop:{mode:"strict_once",max_age_ms:60000}});s.activate();
  const child=spawn(process.execPath,["--no-env-file","--no-install","--config="+join(s.root,"fixed.bunfig.toml"),"-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
  const pid=child.pid!;const childClosed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  const fake=fakeRuntime({recommendAttention:true}),originalCreate=fake.factory.createSupervisor;let rejectClose!:(error:Error)=>void,created=0;
  fake.factory.createSupervisor=async(...args)=>{
    const original=await originalCreate(...args);created++;let poisoned=false;
    const closed=new Promise<AgentCloseReceipt>((_resolve,reject)=>{rejectClose=error=>{poisoned=true;reject(error);};});
    return{...original,identity:{...original.identity,pid},closed,assertHealthy(){if(poisoned)throw new TcrError("owned_group_unverified");original.assertHealthy();},
      async runTurn<T>(turn:AgentTurnOptions<T>){const result=await original.runTurn({...turn,onStarted:ids=>turn.onStarted?.({...ids,pid})});return{...result,runtime:{...result.runtime,pid}};},
      async close(){throw new TcrError("owned_group_unverified");},async cancel(){throw new TcrError("owned_group_unverified");}};
  };
  try{
    const first=new SupervisorDaemon({store:s.store,daemon_id:"daemon",runtimeFactory:fake.factory,ptcFactory:fakePtc,maxResidentSessions:1});daemons.push(first);
    expect((await first.once()).state).toBe("succeeded");const originalProposal=(s.base.db.query("SELECT body FROM agent_proposals").get() as any).body;
    rejectClose(new TcrError("owned_group_unverified"));await Bun.sleep(0);
    expect(s.store.cachedReview({binding_id:"binding",turn_id:"master-turn",window_id:s.window.window_id}).fresh).toBe(false);
    const epoch=s.base.db.query("SELECT close_error,closed_at FROM agent_sessions").get() as any;expect(epoch.close_error).toBe("owned_group_unverified");expect(epoch.closed_at).toBeNull();
    appendFileSync(s.source,'{"type":"message","entry_id":"second"}\n');s.base.enqueue(s.binding,{hook_event_name:"PreCompact",native_session_id:"master-session",native_turn_id:"master-turn",transcript_path:s.source,input_sha256:sha("after-close-failure"),delivery_id:null});
    const failed=await first.once();expect(failed.state).toBe("failed");expect(created).toBe(1);
    const restarted=new SupervisorDaemon({store:new SupervisorStore(s.base),daemon_id:"daemon",runtimeFactory:fake.factory,ptcFactory:fakePtc,maxResidentSessions:1});daemons.push(restarted);
    expect(s.store.retry(String(failed.run_id))).toBe(true);const retried=await restarted.once();expect(retried.state).toBe("failed");expect(retried.error).toBe("supervisor_previous_group_unreconciled");expect(created).toBe(1);
    expect((s.base.db.query("SELECT body FROM agent_proposals").get() as any).body).toBe(originalProposal);
    process.kill(-pid,"SIGKILL");await childClosed;expect(s.store.reconcileSupervisorGroups("daemon")).toBe(1);expect(()=>s.store.assertResidentAdmission("activation",1)).not.toThrow();
    expect(s.store.cachedReview({binding_id:"binding",turn_id:"master-turn",window_id:s.window.window_id}).fresh).toBe(false);
  }finally{try{process.kill(-pid,"SIGKILL");}catch{}await childClosed;}
});
for(const mode of ["signal","close"] as const)test(`ETL cancellation through ${mode} stops only the activated owned helper promptly`,async()=>{
  const s=setup({},true),marker=join(s.root,"etl-started.json"),delayed=join(s.root,"slow-helper.ts");
  writeFileSync(delayed,`import{writeFileSync as mark}from'node:fs';mark(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));await Bun.sleep(1600);\n`+readFileSync(helper,"utf8"));
  s.runtime_config.recorder.helper_command[s.runtime_config.recorder.helper_command.length-1]=delayed;s.policy.config_sha256=sha(canonical(s.runtime_config));s.activate();
  const other=s.base.bind({...s.binding,binding_id:"unactivated",task_id:"other-task",profile:"other",native_session_id:"other-session"});s.base.enqueue(other,{hook_event_name:"Stop",native_session_id:"other-session",native_turn_id:null,transcript_path:s.source,input_sha256:sha("other"),delivery_id:null});
  const{d,fake}=daemon(s);const controller=new AbortController();const pending=d.once(controller.signal);
  for(let i=0;i<100&&!existsSync(marker);i++)await Bun.sleep(5);expect(existsSync(marker)).toBe(true);const started=Date.now();
  if(mode==="signal")controller.abort();else await d.close();
  const result=await pending;expect(result.state).toBe("cancelled_before_claim");expect(Date.now()-started).toBeLessThan(700);expect(fake.status().supervisors).toBe(0);
  expect((s.base.db.query("SELECT state FROM jobs WHERE binding_id='unactivated'").get() as any).state).toBe("queued");
  expect((s.base.db.query("SELECT error_code FROM jobs WHERE binding_id='binding'").get() as any).error_code).toBe("helper_cancelled");
  const pid=JSON.parse(readFileSync(marker,"utf8")).pid;let alive=true;try{process.kill(-pid,0);}catch(e:any){alive=e.code!=="ESRCH";}expect(alive).toBe(false);
});
test("unified ETL honors per-activation max_jobs on each cycle",async()=>{
  const s=setup({},true);appendFileSync(s.source,'{"type":"message","entry_id":"second"}\n');s.base.enqueue(s.binding,{hook_event_name:"PreCompact",native_session_id:"master-session",native_turn_id:"master-turn",transcript_path:s.source,input_sha256:sha("second-budget-window"),delivery_id:null});
  s.runtime_config.recorder.max_jobs=1;s.policy.config_sha256=sha(canonical(s.runtime_config));s.activate();const{d}=daemon(s);
  const first=await d.once();expect(first.extracted).toBe(1);expect((s.base.db.query("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get() as any).n).toBe(1);
  const second=await d.once();expect(second.extracted).toBe(1);expect((s.base.db.query("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get() as any).n).toBe(0);
});
test("Stop cache is advisory by default, explicit strict mode is fresh and once per native turn",async()=>{
  const a=setup();a.activate();const da=daemon(a,fakeRuntime({recommendAttention:true}));await da.d.once();expect(a.store.cachedReview({binding_id:"binding",turn_id:"master-turn",window_id:a.window.window_id,consume_strict:true}).decision).toBe("advisory");
  const b=setup({stop:{mode:"strict_once",max_age_ms:60000}});b.activate();expect(b.store.cachedReview({binding_id:"binding",turn_id:"master-turn",window_id:b.window.window_id,consume_strict:true})).toMatchObject({decision:"unavailable",pending_model_never_blocks:true});
  const db=daemon(b,fakeRuntime({recommendAttention:true}));await db.d.once();const request={binding_id:"binding",turn_id:"master-turn",window_id:b.window.window_id,consume_strict:true};
  expect(b.store.cachedReview({...request,turn_id:"different"}).decision).toBe("advisory");expect(b.store.cachedReview(request).decision).toBe("block_once");expect(b.store.cachedReview(request).decision).toBe("advisory");
});
test("helper AbortSignal refuses pre-aborted launch and closes an owned descendant on cancellation",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-supervisor-cancel-")));roots.push(root);const marker=join(root,"started"),script=join(root,"child.mjs");
  writeFileSync(script,`import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`,{mode:0o600});
  const options=workerOptions({helper:[process.execPath,script],timeoutMs:5000,leaseMs:6000});const pre=new AbortController();pre.abort();await expect(runHelper([process.execPath,script],options,pre.signal)).rejects.toThrow("helper_cancelled");expect(existsSync(marker)).toBe(false);
  const controller=new AbortController(),pending=runHelper([process.execPath,script],options,controller.signal);for(let i=0;i<100&&!existsSync(marker);i++)await Bun.sleep(5);expect(existsSync(marker)).toBe(true);const pids=JSON.parse(readFileSync(marker,"utf8"));controller.abort();await expect(pending).rejects.toThrow("helper_cancelled");
  for(const pid of Object.values(pids) as number[]){let alive=true;try{process.kill(pid,0);}catch(e:any){alive=e.code!=="ESRCH";}expect(alive).toBe(false);}
});
test("scoring child receives one selected synthetic credential and generic helper does not",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-supervisor-score-")));roots.push(root);const script=join(root,"score.mjs");
  writeFileSync(script,'console.log(JSON.stringify({selected:process.env.TCR_SYNTHETIC_KEY==="synthetic-fake-value",other:process.env.OTHER_SYNTHETIC_KEY!==undefined,argv_has_value:process.argv.some(x=>x.includes("synthetic-fake-value"))}));',{mode:0o600});
  const options=workerOptions({helper:[process.execPath,script],timeoutMs:2000,leaseMs:3000}),argv=[process.execPath,script,"score-prepared"];
  expect(await runScoringHelper(argv,options,{envName:"TCR_SYNTHETIC_KEY",value:"synthetic-fake-value"})).toEqual({selected:true,other:false,argv_has_value:false});
  expect(await runHelper(argv,options)).toEqual({selected:false,other:false,argv_has_value:false});
  await expect(runScoringHelper([process.execPath,script,"ingest"],options,{envName:"TCR_SYNTHETIC_KEY",value:"synthetic-fake-value"})).rejects.toThrow("scoring_operation_required");
  await expect(runScoringHelper(argv,options,{envName:"NODE_OPTIONS",value:"synthetic-fake-value"})).rejects.toThrow();
});

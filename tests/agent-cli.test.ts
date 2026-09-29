import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/store.ts";
import { configTemplate } from "../src/config.ts";
import { bunRuntimeFlags } from "../src/bun-runtime.ts";
import { canonical, sha } from "../src/security.ts";
import { SupervisorStore } from "../src/supervisor-store.ts";
import { agentCommand, createConfiguredAgentDaemon } from "../src/agent-cli.ts";
import { fixtureQualifiedRuntime } from "./fixture-qualified-runtime.ts";

const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const cli=join(import.meta.dir,"../src/cli.ts");
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),"tcr-agent-cli-"));roots.push(root);
  const state=join(root,"state"),source=join(root,"synthetic.jsonl"),nativeHome=join(root,"native-home"),executable=join(root,"fake-codex");
  mkdirSync(nativeHome,{mode:0o700});writeFileSync(source,'{"type":"message","entry_id":"synthetic"}\n');
  writeFileSync(executable,'#!/bin/sh\nexit 91\n');chmodSync(executable,0o700);
  const store=new Store(state,{initialize:true});stores.push(store);
  store.bind({schema_version:"task-checkpoint-record.binding.v1",binding_id:"b",task_id:"task",project_id:"project",client:"codex",profile:"test",runtime_home:null,native_session_id:"synthetic-session",role:"master",source_root:root,sources:[{source_id:"raw",path:source,format:"codex",start_at:"new"}]});
  const config=configTemplate();config.recorder.state_dir=state;config.codex.home=nativeHome;config.codex.executable=executable;
  config.agent_service.runtime_update.mode="pinned";
  const configFile=join(root,"suite.json"),admissionFile=join(root,"admission.json");writeFileSync(configFile,JSON.stringify(config));
  const admission={schema_version:"task-checkpoint-record.agent-activation.v1",activation_id:"a",binding_id:"b",daemon_id:"d"};writeFileSync(admissionFile,JSON.stringify(admission));
  const run=(args:string[],env:NodeJS.ProcessEnv={},input?:unknown)=>spawnSync(process.execPath,[...bunRuntimeFlags(),cli,...args],{cwd:root,encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),env:{HOME:homedir(),PATH:process.env.PATH,...env}});
  return{root,state,store,config,configFile,admission,admissionFile,run,agents:new SupervisorStore(store)};
}
function packet(){
  const request={model:"typesafe/jev-1.13-20260917",state:"Synthetic only",questions:{call:{type:"noul",instructions:"Keep synthetic call?"},result:{type:"noul",instructions:"Keep synthetic result?"}},provider:{allow_fallbacks:false}},pair_map={pair:{keepCall:"call",keepResult:"result"}},provider="openrouter",data_class="synthetic";
  const packet_sha256=sha(canonical({provider,data_class,request,pair_map}));
  return{packet_handle:"p",packet_sha256,admission_ref:"synthetic-owner-admission",attempt_budget:1,prepared:{schema_version:"ultrafast-atif.prepared-decision.v1",provider,data_class,request,pair_map,request_sha256:sha(canonical(request)),request_bytes:Buffer.byteLength(canonical(request)),pair_map_sha256:sha(canonical(pair_map)),packet_sha256}};
}
describe("explicit native agent CLI",()=>{
  test("runtime status and retained rollback use local receipts without a database, login or native model",()=>{
    const s=fixture(),absent=join(s.root,"absent-managed");
    const missing=s.run(["runtime","status","--root",absent]);expect(missing.status).toBe(0);expect(existsSync(absent)).toBe(false);
    const qualified=fixtureQualifiedRuntime(s.config.codex.executable!,"0.998.0"),root=dirname(dirname(dirname(qualified.qualificationPath)));
    mkdirSync(join(root,"checks"));writeFileSync(join(root,".update.lock"),"",{mode:0o600});
    writeFileSync(join(root,"current.json"),JSON.stringify({schema_version:"task-checkpoint.codex-selection.v1",selection:qualified}),{mode:0o600});
    const inspected=s.run(["runtime","status","--root",root]);expect({status:inspected.status,stdout:inspected.stdout,stderr:inspected.stderr}).toMatchObject({status:0});expect(JSON.parse(inspected.stdout).selection).toEqual(qualified);
    const held=s.run(["runtime","rollback","--root",root,"--version","0.998.0"]);expect(held.status).toBe(0);expect(JSON.parse(held.stdout)).toMatchObject({status:"held_not_latest",latestCheckSucceeded:false,selection:qualified});
    const again=s.run(["runtime","update","--root",root]);expect(again.status).toBe(0);expect(JSON.parse(again.stdout).status).toBe("held_not_latest");
    expect(s.run(["runtime","rollback","--root",root]).status).toBe(1);
    expect(s.run(["runtime","status","--root",root,"--resume-latest","true"]).status).toBe(1);
    expect(s.run(["runtime","update","--root",root,"--resume-latest","perhaps"]).status).toBe(1);
    expect(s.agents.initialized()).toBe(false);
  });
  test("local held pointer changes trigger the next idle check before the network interval",async()=>{
    const s=fixture(),a=fixtureQualifiedRuntime(s.config.codex.executable!,"0.998.0"),b=fixtureQualifiedRuntime(s.config.codex.executable!,"0.999.0");
    const root=dirname(dirname(dirname(a.qualificationPath)));s.config.agent_service.runtime_update={mode:"latest-stable",root,check_interval_ms:14400000};
    writeFileSync(s.configFile,JSON.stringify(s.config));
    const pointer=(selection:typeof a)=>writeFileSync(join(root,"current.json"),JSON.stringify({schema_version:"task-checkpoint.codex-selection.v1",selection}));pointer(b);
    expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    let calls=0;const d=createConfiguredAgentDaemon(s.agents,"d",{}, {ensureRuntime:async options=>{
      calls++;expect(options.force).toBe(calls===1);return{status:calls===1?"current":"held_not_latest",selection:calls===1?b:a,checkedAt:new Date().toISOString(),latestCheckSucceeded:calls===1,updateFailure:null};
    }});
    try{expect((await d.once()).state).toBe("idle");expect((await d.once()).state).toBe("idle");expect(calls).toBe(1);
      pointer(a);writeFileSync(join(root,"hold.json"),JSON.stringify({selection:a,held_at:new Date().toISOString()}));
      expect((await d.once()).state).toBe("idle");expect(calls).toBe(2);expect((s.agents.status() as any).runtime_updates[0]).toMatchObject({status:"held_not_latest",stale:true,selection:a});
      expect((s.agents.status() as any).activations[0]).toMatchObject({rounds_reserved:0,native_calls:0});
    }finally{await d.close();}
  });
  test.each(["current","update_failed"] as const)("concurrent held selection invalidates the cached %s result at the next idle cycle",async firstStatus=>{
    const s=fixture(),a=fixtureQualifiedRuntime(s.config.codex.executable!,"0.998.0"),b=fixtureQualifiedRuntime(s.config.codex.executable!,"0.999.0");
    const root=dirname(dirname(dirname(a.qualificationPath)));s.config.agent_service.runtime_update={mode:"latest-stable",root,check_interval_ms:14400000};
    writeFileSync(s.configFile,JSON.stringify(s.config));writeFileSync(join(root,"current.json"),JSON.stringify({schema_version:"task-checkpoint.codex-selection.v1",selection:a}));
    expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    let calls=0;const d=createConfiguredAgentDaemon(s.agents,"d",{}, {ensureRuntime:async options=>{
      calls++;expect(options.force).toBe(calls===1);
      if(calls===1){
        // The updater has fixed result A, then another owner operation atomically holds B before its promise resumes.
        writeFileSync(join(root,"current.json"),JSON.stringify({schema_version:"task-checkpoint.codex-selection.v1",selection:b,hold:{held_at:new Date().toISOString(),reason:"explicit_operator_rollback"}}));
        return{status:firstStatus,selection:a,checkedAt:new Date().toISOString(),latestCheckSucceeded:firstStatus==="current",updateFailure:firstStatus==="current"?null:{code:"synthetic_update_failure"}};
      }
      return{status:"held_not_latest",selection:b,checkedAt:new Date().toISOString(),latestCheckSucceeded:false,updateFailure:null};
    }});
    try{
      expect((await d.once()).state).toBe("idle");expect((s.agents.status() as any).runtime_updates[0].selection).toEqual(a);
      expect((await d.once()).state).toBe("idle");expect(calls).toBe(2);
      expect((s.agents.status() as any).runtime_updates[0]).toMatchObject({status:"held_not_latest",stale:true,selection:b});
      expect((await d.once()).state).toBe("idle");expect(calls).toBe(2);
      expect((s.agents.status() as any).activations[0]).toMatchObject({rounds_reserved:0,native_calls:0});
    }finally{await d.close();}
  });
  test("latest mode admits a dedicated home without a preinstalled binary; update failures are explicit and bounded",async()=>{
    const s=fixture();s.config.codex.executable=null;s.config.agent_service.runtime_update.mode="latest-stable";writeFileSync(s.configFile,JSON.stringify(s.config));
    expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    let calls=0;const d=createConfiguredAgentDaemon(s.agents,"d",{}, {ensureRuntime:async options=>{
      calls++;expect(options).toMatchObject({root:join(s.state,"codex-runtime"),busy:false,force:true,currentExecutable:null});
      return{status:"update_failed",selection:null,checkedAt:"2026-01-01T00:00:00Z",latestCheckSucceeded:false,updateFailure:{code:"synthetic_offline"}};
    }});
    try{expect((await d.once()).state).toBe("runtime_unavailable");expect((await d.once()).state).toBe("runtime_unavailable");expect(calls).toBe(1);
      expect((s.agents.status() as any).runtime_updates).toMatchObject([{daemon_id:"d",stale:true,status:"update_failed",selection:null,update_failure:{code:"synthetic_offline"}}]);
      expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
    }finally{await d.close();}
  });
  test("status/schema/activation are model-free; future Hook wakes are idempotent",()=>{
    const s=fixture();const before=s.run(["agent","status","--state",s.state]);expect(before.status).toBe(0);expect(JSON.parse(before.stdout).initialized).toBe(false);
    expect(s.agents.initialized()).toBe(false);expect(s.run(["schema","agent-activation"]).status).toBe(0);
    const activated=s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]);expect(activated.status).toBe(0);
    const receipt=JSON.parse(activated.stdout);expect(receipt.active).toBe(true);expect(receipt.daemon_started).toBe(false);
    const hook={hook_event_name:"PreCompact",session_id:"synthetic-session",turn_id:"synthetic-turn"};
    for(let i=0;i<2;i++)expect(s.run(["hook","--config",s.configFile,"--client","codex","--profile","test"],{},hook).status).toBe(0);
    expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_wakes").get() as any).n).toBe(1);
    expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
    expect(s.run(["agent","jobs","--state",s.state,"--limit","10"]).status).toBe(0);
    expect(s.run(["agent","deactivate","--state",s.state,"--activation","a"]).status).toBe(0);
  });
  test("positive external budget preflights one selected key before durable activation and never stores it",()=>{
    const s=fixture();s.config.agent_service.external_score_max_calls=1;writeFileSync(s.configFile,JSON.stringify(s.config));
    writeFileSync(s.admissionFile,JSON.stringify({...s.admission,prepared_packets:[packet()]}));
    const missing=s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]);expect(missing.status).toBe(1);expect(missing.stderr).toContain("agent_provider_key_missing");expect(s.agents.initialized()).toBe(false);
    const key="synthetic-provider-key";const admitted=s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile],{OPENROUTER_API_KEY:key});
    expect(admitted.status).toBe(0);expect(admitted.stdout+admitted.stderr).not.toContain(key);
    expect(canonical(s.store.db.query("SELECT * FROM agent_activations").all())).not.toContain(key);
    expect(s.agents.activation("a").policy.total_external_score_calls).toBe(1);
    const startup=s.run(["agent","start","--state",s.state,"--daemon","d"]);expect(startup.status).toBe(1);expect(startup.stderr).toContain("agent_provider_key_missing");
    expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_services").get() as any).n).toBe(0);
  });
  test("old configuration bytes changing do not alter the stored native activation",()=>{
    const s=fixture();expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    const original=s.agents.activation("a");s.config.codex.supervisor.effort="high";writeFileSync(s.configFile,JSON.stringify(s.config));
    expect(s.agents.activation("a").policy.supervisor.effort).toBe("medium");
    const changed=s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]);expect(changed.status).toBe(1);expect(changed.stderr).toContain("activation_conflict");
    expect(s.agents.activation("a").policy_sha256).toBe(original.policy_sha256);
  });
  test("explicit idle detached daemon starts/stops with owned runtime flags and no native model launch",async()=>{
    const s=fixture();expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    let pid:number|undefined;
    try{
      const started=s.run(["agent","start","--state",s.state,"--daemon","d"]);expect(started.status).toBe(0);
      const receipt=JSON.parse(started.stdout);pid=receipt.pid;expect(receipt.state).toBe("start_admitted");
      expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
      expect(s.run(["agent","stop","--state",s.state,"--daemon","d"]).status).toBe(0);
      const until=Date.now()+3000;let stopped=false;
      while(Date.now()<until){const row=s.store.db.query("SELECT state FROM agent_services WHERE daemon_id='d'").get() as any;if(row?.state==="stopped"){stopped=true;break;}await Bun.sleep(25);}
      expect(stopped).toBe(true);
      const closeUntil=Date.now()+1000;while(pid&&Date.now()<closeUntil){try{process.kill(pid,0);}catch{pid=undefined;break;}await Bun.sleep(25);}
      expect(pid).toBeUndefined();
    }finally{
      if(pid){try{process.kill(-pid,"SIGTERM");}catch{/* already closed owned process group */}}
    }
  });
  test("slow unacknowledged startup is reaped before any extraction or native work",async()=>{
    const s=fixture();expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    s.agents.registerService("unrelated","unrelated-owner");
    const slow=join(s.root,"slow-start.ts");writeFileSync(slow,`await Bun.sleep(150);const {main}=await import(${JSON.stringify(new URL("../src/cli.ts",import.meta.url).href)});await main(process.argv.slice(2));\n`);
    await expect(agentCommand({command:"agent start",options:new Map([["daemon",["d"]],["startup-timeout-ms",["1"]]]),store:s.store,cliEntrypoint:slow,environment:{HOME:homedir(),PATH:process.env.PATH}})).rejects.toThrow("agent_service_start_not_observed");
    await Bun.sleep(200);expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
    expect(s.store.db.query("SELECT state,stop_requested FROM agent_services WHERE daemon_id='unrelated'").get()).toEqual({state:"running",stop_requested:0});
    const receipt=await agentCommand({command:"agent start",options:new Map([["daemon",["d"]],["startup-timeout-ms",["3000"]]]),store:s.store,cliEntrypoint:slow,environment:{HOME:homedir(),PATH:process.env.PATH}}) as {state:string;pid:number};
    try{expect(receipt.state).toBe("start_admitted");expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);}
    finally{s.agents.requestStop("d");const until=Date.now()+3000;let gone=false;while(Date.now()<until){try{process.kill(receipt.pid,0);}catch{gone=true;break;}await Bun.sleep(25);}if(!gone)process.kill(-receipt.pid,"SIGTERM");expect(gone).toBe(true);}
  });
  test("parent EOF or invalid nonce closes a waiting child before queued ETL and models",async()=>{
    for(const invalid of [false,true]){
      const s=fixture();expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
      expect(s.run(["hook","--config",s.configFile,"--client","codex","--profile","test"],{},{hook_event_name:"PreCompact",session_id:"synthetic-session",turn_id:"gated-turn"}).status).toBe(0);
      const child=spawn(process.execPath,[...bunRuntimeFlags(),cli,"agent","run","--state",s.state,"--daemon","d","--startup-nonce","11111111-1111-1111-1111-111111111111"],{cwd:s.root,env:{HOME:homedir(),PATH:process.env.PATH},detached:true,stdio:["pipe","ignore","ignore"]});
      let closed=false;const completion=new Promise<number|null>(resolve=>{child.once("close",code=>{closed=true;resolve(code);});});
      try{
        const until=Date.now()+3000;let waiting=false;while(Date.now()<until){const row=s.store.db.query("SELECT state FROM agent_services WHERE daemon_id='d'").get() as any;if(row?.state==="waiting_for_ack"){waiting=true;break;}await Bun.sleep(10);}
        expect(waiting).toBe(true);expect((s.store.db.query("SELECT state FROM jobs").get() as any).state).toBe("queued");
        expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
        child.stdin!.end(invalid?"wrong-nonce\n":undefined);
        const code=await Promise.race([completion,Bun.sleep(3000).then(()=>-999)]);expect(code).toBe(1);expect(closed).toBe(true);
        expect((s.store.db.query("SELECT state FROM agent_services WHERE daemon_id='d'").get() as any).state).toBe("stopped");
        expect((s.store.db.query("SELECT state FROM jobs").get() as any).state).toBe("queued");
        expect((s.store.db.query("SELECT COUNT(*) AS n FROM agent_model_calls").get() as any).n).toBe(0);
      }finally{if(!closed&&child.pid){child.stdin?.destroy();try{process.kill(-child.pid,"SIGKILL");}catch{}await completion;}}
    }
  });
  test("post-readiness unconfirmed acknowledgement is reported as admitted_unknown without retry",async()=>{
    const s=fixture();expect(s.run(["agent","activate","--config",s.configFile,"--file",s.admissionFile]).status).toBe(0);
    const disconnected=join(s.root,"disconnected-ready.ts");
    writeFileSync(disconnected,`import {closeSync} from "node:fs";import {Store} from ${JSON.stringify(new URL("../src/store.ts",import.meta.url).href)};import {SupervisorStore} from ${JSON.stringify(new URL("../src/supervisor-store.ts",import.meta.url).href)};const store=new Store(process.argv[process.argv.indexOf("--state")+1]);const agents=new SupervisorStore(store);agents.registerService("d","synthetic-disconnected-owner",Date.now(),true);closeSync(0);await Bun.sleep(500);agents.serviceStopped("d","synthetic-disconnected-owner");store.close();\n`);
    const result=await agentCommand({command:"agent start",options:new Map([["daemon",["d"]]]),store:s.store,cliEntrypoint:disconnected,environment:{HOME:homedir(),PATH:process.env.PATH}}) as {state:string;pid:number;automatic_retry:boolean;running_observed_after_ack:boolean};
    try{expect(result.state).toBe("admitted_unknown");expect(result.automatic_retry).toBe(false);expect(result.running_observed_after_ack).toBe(false);expect(result.pid).toBeGreaterThan(0);}
    finally{const until=Date.now()+2000;let gone=false;while(Date.now()<until){try{process.kill(result.pid,0);}catch{gone=true;break;}await Bun.sleep(25);}if(!gone)process.kill(-result.pid,"SIGTERM");expect(gone).toBe(true);}
  });
});

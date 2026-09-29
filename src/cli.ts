import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Store } from "./store.ts";
import { handleHook } from "./hooks.ts";
import { drain, runService, workerOptions } from "./worker.ts";
import { absolute, childEnvironment, fail, integer, limitedJSON, oneOf, parseJson, readFileBounded, safeError, str } from "./security.ts";
import { schema } from "./schemas.ts";
import type { WorkerOptions } from "./types.ts";
import { ConfigurationError, checkConfigReport, configSchema, loadConfig, writeConfig, type DecisionProvider, type PortableConfig } from "./config.ts";
import { authPlan, setupAuth, runAuth } from "./config-runtime.ts";
import { bunRuntimeFlags } from "./bun-runtime.ts";
import { agentActivationSchema } from "./agent-config.ts";
import { agentHookOutput } from "./agent-hook.ts";
import { version } from "../package.json";

const HELP={
  name:"task-checkpoint-record",version,schema_version:"task-checkpoint-record.help.v1",
  commands:{
    "config init":"--file NEW_JSON [--provider openrouter|typesafe]; new unified config, no credentials/state/auth effects",
    "config check":"--config JSON; validate and resolve explicit configuration, no credential or provider checks",
    "config schema":"portable versioned JSON Schema; no file or state access",
    "auth plan":"--config JSON; preview new-only dedicated Codex profile setup and exact plan SHA",
    "auth setup":"--config JSON --plan-sha256 SHA; create reviewed new profile only, never copy credentials",
    "auth login":"--config JSON; explicit official codex login --device-auth with dedicated CODEX_HOME, inherited terminal",
    "auth status":"--config JSON; official codex login status, no authentication-file reads by this wrapper",
    "runtime status":"--root ABS_DIR, or --config JSON/--state ABS_DIR; local qualified runtime status without network or models",
    "runtime plan":"same root options; inspect official latest stable release, no installation, models or login",
    "runtime update":"same root options [--resume-latest true]; explicitly install and qualify official latest stable; an explicit rollback hold persists until resumed",
    "runtime rollback":"same root options --version X.Y.Z; hold a retained qualified runtime until explicit resume; running sessions rotate only at a safe idle cycle",
    "schema":"binding|query|helper-page|agent-activation; JSON Schema without state creation",
    "init":"--state ABS_DIR; creates private SQLite state only",
    "bind":"--state ABS_DIR --file ABS_BINDING_JSON; immutable explicit task/session/source binding",
    "unbind":"--state ABS_DIR --binding ID; disables new ingestion; keeps existing evidence",
    "hook":"--state ABS_DIR --client codex|claude|pi --profile ID; bounded native JSON on stdin, legal native JSON on stdout",
    "service once":"--state ABS_DIR [--helper EXEC --helper-arg ARG] [--concurrency 2 --max-jobs 64]; deterministic bounded drain",
    "service run":"same options; explicit foreground worker loop, independently stopped through state",
    "service start":"same options; explicit detached worker start; never runs implicitly from a hook",
    "service stop":"--state ABS_DIR; requests cooperative stop, active bounded extraction finishes",
    "service status":"--state ABS_DIR; read existing status, no start",
    "agent activate":"--config JSON --file ABS_ADMISSION_JSON; freeze one task admission and finite native policy, no daemon start",
    "agent status":"--state ABS_DIR; bounded activation/service/job metadata, no startup",
    "agent jobs":"--state ABS_DIR [--activation ID --job-state STATE --limit 20 --offset 0]; bounded native-job metadata",
    "agent resolve":"--state ABS_DIR --link tcr://STORE/KIND/ID [--fields FIELD,...]; KIND is agent-proposals|agent-evidence|agent-runs; bounded stored metadata, no URI following",
    "agent run":"--state ABS_DIR --daemon ID [--once true]; explicit foreground native supervisor/worker service",
    "agent start":"--state ABS_DIR --daemon ID [--startup-timeout-ms 2000]; explicit detached native service with owned readiness/ack handshake",
    "agent stop":"--state ABS_DIR --daemon ID; cooperative owned native service shutdown",
    "agent deactivate":"--state ABS_DIR --activation ID; deactivate admission and request owned work cancellation",
    "agent retry":"--state ABS_DIR --run ID; explicit retry within existing durable activation budgets",
    "agent cancel":"--state ABS_DIR --run ID; request cancellation of one native job",
    "agent verify":"--state ABS_DIR --run ID, or --binding ID --window ID [--turn ID --consume-strict true]; cached provenance/review only, never model acceptance",
    "query":"--state ABS_DIR --kind records|events|windows|checkpoints [--filter KEY=VALUE] [--fields FIELD,... --limit 20 --offset 0]",
    "resolve":"--state ABS_DIR --link tcr://STORE/KIND/ID [--fields FIELD,...]; store metadata only, no source following",
    "recall":"--state ABS_DIR --binding ID; cached body-free windows and job states",
    "checkpoint import":"--state ABS_DIR --binding ID --file ABS_EVENT_JSON; explicit envelope/binding validation level, pointers never followed",
    "retry":"--state ABS_DIR --job ID; explicit retry of one failed job"
  },
  invariants:["No RAW bodies in default outputs","No implicit daemon or model startup","Observer/worker hooks are inert","Native IDs are never invented from hook context","Stop defaults to advisory; explicit strict_once uses only a fresh exact-turn cached review once","SQLite is application storage with OTel correlation potential, not an OTel collector"]
};
type Args={words:string[];opts:Map<string,string[]>};
function argumentsOf(argv:string[]):Args{
  const words:string[]=[];const opts=new Map<string,string[]>();
  if(argv.length>128)fail("argument_budget_exceeded");
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];str(arg,8192);
    if(arg==="--help"||arg==="-h"){words.push("help");continue;}
    if(arg==="--json"){opts.set("json",["true"]);continue;}
    if(arg.startsWith("--")){
      const key=arg.slice(2);const value=argv[++i];if(value===undefined)fail("missing_option_value");str(value,8192);
      if(opts.has(key)&&!["filter","helper-arg"].includes(key))fail("duplicate_option");
      opts.set(key,[...(opts.get(key)??[]),value]);
    }else words.push(arg);
  }return{words,opts};
}
function option(args:Args,key:string,required=false):string|undefined{
  const value=args.opts.get(key)?.[0];if(required&&value===undefined)fail("missing_option");return value;
}
function allowed(args:Args,names:string[]):void{
  for(const key of args.opts.keys())if(!["state","config","config-sha256","json",...names].includes(key))fail("unknown_option");
}
function number(args:Args,key:string,fallback:number):number{
  const raw=option(args,key);if(raw===undefined)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(raw))fail("invalid_integer");return integer(Number(raw),0,Number.MAX_SAFE_INTEGER);
}
const WORKER_FLAGS=["helper","helper-arg","concurrency","max-jobs","timeout-ms","lease-ms","page-bytes","page-limit","stdout-bytes"];
function options(args:Args,config?:PortableConfig):WorkerOptions{
  const c=config?.recorder;
  const helperOverride=args.opts.has("helper")||args.opts.has("helper-arg");
  return workerOptions({helper:helperOverride?[option(args,"helper")??c?.helper_command[0]??"ultrafast-atif-helper",...(args.opts.get("helper-arg")??[])]:c?.helper_command??["ultrafast-atif-helper"],
    concurrency:number(args,"concurrency",c?.concurrency??2),maxJobs:number(args,"max-jobs",c?.max_jobs??64),timeoutMs:number(args,"timeout-ms",c?.timeout_ms??10000),leaseMs:number(args,"lease-ms",c?.lease_ms??30000),pageBytes:number(args,"page-bytes",c?.page_bytes??1024*1024),pageLimit:number(args,"page-limit",c?.page_limit??100),stdoutBytes:number(args,"stdout-bytes",c?.stdout_bytes??2*1024*1024)});
}
function output(value:unknown):void{process.stdout.write(limitedJSON(value)+"\n");}
async function stdinJSON():Promise<unknown>{
  return new Promise((resolve,reject)=>{
    let bytes=0;const chunks:Buffer[]=[];let done=false;
    const cleanup=()=>{clearTimeout(timer);process.stdin.off("data",data);process.stdin.off("end",end);process.stdin.off("error",error);process.stdin.pause();};
    const error=()=>{if(!done){done=true;cleanup();reject(new Error("stdin_failed"));}};
    const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>64*1024){done=true;cleanup();try{fail("hook_input_budget_exceeded");}catch(e){reject(e);}return;}chunks.push(chunk);};
    const end=()=>{if(done)return;done=true;cleanup();try{resolve(parseJson(Buffer.concat(chunks).toString("utf8")));}catch(e){reject(e);}};
    const timer=setTimeout(()=>{if(done)return;done=true;cleanup();try{fail("hook_input_deadline_exceeded");}catch(e){reject(e);}},250);
    process.stdin.on("data",data);process.stdin.once("end",end);process.stdin.once("error",error);process.stdin.resume();
  });
}
export async function main(argv:string[]):Promise<void>{
  let store:Store|undefined;let nativeHook=argv.includes("hook");
  try{
    const args=argumentsOf(argv);const command=args.words.join(" ");nativeHook=command==="hook";
    if(command==="help"||command===""||args.words.includes("help")){output(HELP);return;}
    if(args.words[0]==="schema"&&args.words.length===2){allowed(args,[]);output(args.words[1]==="agent-activation"?agentActivationSchema():schema(args.words[1]));return;}
    if(command==="config schema"){allowed(args,[]);output(configSchema());return;}
    if(command==="config init"){
      allowed(args,["file","provider"]);if(args.opts.has("config")||args.opts.has("config-sha256")||args.opts.has("state"))fail("conflicting_option");
      const file=option(args,"file",true)!;const provider=option(args,"provider")??"openrouter";
      writeConfig(file,provider as DecisionProvider);output({schema_version:"task-checkpoint.config-created.v1",file:resolve(file),credentials_written:false,model_called:false});return;
    }
    if(option(args,"config-sha256")&&!option(args,"config"))fail("config_required_for_digest");
    const config=option(args,"config")?loadConfig(option(args,"config")!,option(args,"config-sha256")):undefined;
    if(command==="config check"){allowed(args,[]);if(!config)fail("config_required");output(checkConfigReport(config));return;}
    if(command.startsWith("runtime ")){
      if(!["runtime status","runtime plan","runtime update","runtime rollback"].includes(command))fail("unknown_command");
      allowed(args,["root",...(command==="runtime update"?["resume-latest"]:command==="runtime rollback"?["version"]:[])]);
      const resume=option(args,"resume-latest");if(resume!==undefined&&resume!=="true"&&resume!=="false")fail("invalid_boolean_option");
      const state=option(args,"state")??config?.recorder.state_dir;
      const root=absolute(option(args,"root")??config?.agent_service.runtime_update.root??(state?join(absolute(state),"codex-runtime"):fail("runtime_root_required")));
      const {runRuntimeUpdateCommand,ensureLatestCodexRuntime}=await import("./runtime-update.ts");
      const abort=new AbortController(),stop=()=>abort.abort();process.once("SIGTERM",stop);process.once("SIGINT",stop);
      try{const options={root,checkIntervalMs:config?.agent_service.runtime_update.check_interval_ms,signal:abort.signal};
        const report=command==="runtime update"?await ensureLatestCodexRuntime({...options,force:true,resumeLatest:resume==="true"})
          :await runRuntimeUpdateCommand(command==="runtime status"?"status":command==="runtime plan"?"plan":"rollback",
            {...options,...(command==="runtime rollback"?{rollbackVersion:option(args,"version",true)!}:{})});
        output(report);if(report.status==="update_failed")process.exitCode=1;
      }finally{process.off("SIGTERM",stop);process.off("SIGINT",stop);}return;
    }
    if(command.startsWith("auth ")){
      if(!config)fail("config_required");
      if(command==="auth plan"){allowed(args,[]);output(authPlan(config));return;}
      if(command==="auth setup"){allowed(args,["plan-sha256"]);output(setupAuth(config,option(args,"plan-sha256",true)!));return;}
      if(command==="auth login"||command==="auth status"){allowed(args,[]);process.exitCode=await runAuth(config,command==="auth login"?"login":"status");return;}
      fail("unknown_command");
    }
    const state=absolute(option(args,"state")??config?.recorder.state_dir??process.env.TASK_CHECKPOINT_RECORD_STATE??fail("state_required"));
    if(command==="init"){allowed(args,[]);store=new Store(state,{initialize:true});output(store.status());return;}
    if(command==="hook"){
      allowed(args,["client","profile"]);
      const client=option(args,"client",true),profile=option(args,"profile",true);
      const input=await stdinJSON();store=new Store(state,{busyMs:25});
      const result=handleHook(store,client,profile,input,process.env.TASK_CHECKPOINT_RECORD_ROLE??(process.env.TASK_CHECKPOINT_RECORD_WORKER==="1"?"worker":undefined));
      output(agentHookOutput(store,result,client!,input));return;
    }
    store=new Store(state);
    if(command.startsWith("agent ")){
      const {agentCommand}=await import("./agent-cli.ts");
      output(await agentCommand({command,options:args.opts,store,config,cliEntrypoint:fileURLToPath(import.meta.url)}));return;
    }
    switch(command){
      case "bind":allowed(args,["file"]);output(store.bind(parseJson(readFileBounded(absolute(option(args,"file",true)),64*1024).toString("utf8"))));break;
      case "unbind":allowed(args,["binding"]);output({disabled:store.unbind(option(args,"binding",true)!)});break;
      case "retry":allowed(args,["job"]);output({queued:store.retry(option(args,"job",true)!)});break;
      case "status":case "service status":allowed(args,[]);output(store.status());break;
      case "service stop":allowed(args,[]);output({stop_requested:store.stopService(),policy:"cooperative_after_bounded_active_work"});break;
      case "service once":allowed(args,WORKER_FLAGS);output(await drain(store,options(args,config)));break;
      case "service run":{
        allowed(args,WORKER_FLAGS);const opts=options(args,config);const abort=new AbortController();
        const stop=()=>abort.abort();process.once("SIGTERM",stop);process.once("SIGINT",stop);
        try{await runService(store,opts,abort.signal);output({state:"stopped"});}finally{process.off("SIGTERM",stop);process.off("SIGINT",stop);}break;
      }
      case "service start":{
        allowed(args,WORKER_FLAGS);const effective=workerOptions(options(args,config));
        const childArgs=[...bunRuntimeFlags(),fileURLToPath(import.meta.url),"--state",state,"service","run"];
        childArgs.push("--helper",effective.helper[0]);for(const value of effective.helper.slice(1))childArgs.push("--helper-arg",value);
        for(const [flag,value] of Object.entries({concurrency:effective.concurrency,"max-jobs":effective.maxJobs,"timeout-ms":effective.timeoutMs,"lease-ms":effective.leaseMs,"page-bytes":effective.pageBytes,"page-limit":effective.pageLimit,"stdout-bytes":effective.stdoutBytes}))childArgs.push("--"+flag,String(value));
        const child=spawn(process.execPath,childArgs,{detached:true,stdio:"ignore",env:childEnvironment("observer")});
        child.on("error",()=>{});child.unref();
        const deadline=Date.now()+2000;let running=false;
        while(Date.now()<deadline){const row=store.db.query("SELECT pid,heartbeat,state FROM services WHERE service_id='daemon'").get() as {pid:number;heartbeat:number;state:string}|null;
          if(row&&row.pid===child.pid&&row.state==="running"&&row.heartbeat>Date.now()-2000){running=true;break;}await Bun.sleep(50);}
        if(!running)fail("service_start_not_observed");output({state:"running",pid:child.pid,store_id:store.storeId,explicit_start:true});break;
      }
      case "query":{
        allowed(args,["kind","filter","fields","limit","offset"]);const filters:Record<string,string>=Object.create(null);
        for(const raw of args.opts.get("filter")??[]){const at=raw.indexOf("=");if(at<1)fail("invalid_filter");const key=raw.slice(0,at);if(Object.hasOwn(filters,key))fail("duplicate_filter");filters[key]=str(raw.slice(at+1));}
        output(store.query({kind:oneOf(option(args,"kind",true),["records","events","windows","checkpoints"] as const),filters,fields:option(args,"fields")?.split(","),limit:number(args,"limit",20),offset:number(args,"offset",0)}));break;
      }
      case "resolve":allowed(args,["link","fields"]);output(store.resolve(option(args,"link",true)!,option(args,"fields")?.split(",")));break;
      case "recall":allowed(args,["binding"]);output(store.cachedRecall(option(args,"binding",true)!));break;
      case "checkpoint import":allowed(args,["binding","file"]);output(store.importCheckpoint(option(args,"binding",true)!,absolute(option(args,"file",true))));break;
      default:fail("unknown_command");
    }
  }catch(error){
    const code=error instanceof ConfigurationError?error.code:safeError(error);
    if(nativeHook){try{store?.count("hook_drop_"+code);}catch{/* lock/open failure cannot promise a durable counter */}output({});process.stderr.write(JSON.stringify({schema_version:"task-checkpoint-record.error.v1",error:code,enqueued:false})+"\n");}
    else{process.stderr.write(JSON.stringify({schema_version:"task-checkpoint-record.error.v1",error:code})+"\n");process.exitCode=1;}
  }finally{store?.close();}
}
if(import.meta.main)await main(process.argv.slice(2));

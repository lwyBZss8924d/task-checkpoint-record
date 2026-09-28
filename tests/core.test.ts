import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { handleHook } from "../src/hooks.ts";
import { drain, processJob, runHelper, workerOptions } from "../src/worker.ts";
import { canonical, childEnvironment, fingerprint, openRegular, sha } from "../src/security.ts";
import { closeSync } from "node:fs";
import type { Binding, HookMetadata, Page, WorkerOptions } from "../src/types.ts";

const roots:string[]=[];const stores:Store[]=[];
const fixture=fileURLToPath(new URL("./fixture-helper.ts",import.meta.url));
const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
const options:WorkerOptions={helper:[process.execPath,fixture],timeoutMs:2000,leaseMs:4000,pageLimit:2,pageBytes:16384};
function setup(text='{"type":"session","session_id":"session-1"}\n{"type":"turn","turn_id":"old-turn"}\n{"type":"message","text":"PRIVATE_TEST_BODY"}\n'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-test-")));roots.push(root);
  const sourceRoot=join(root,"sources");mkdirSync(sourceRoot,{mode:0o700});const source=join(sourceRoot,"raw.jsonl");writeFileSync(source,text,{mode:0o600});
  const state=join(root,"state");const store=new Store(state,{initialize:true});stores.push(store);
  const binding:Binding={schema_version:"task-checkpoint-record.binding.v1",binding_id:"binding-1",task_id:"task-1",project_id:"project-1",client:"codex",profile:"test",runtime_home:null,native_session_id:"session-1",role:"master",source_root:sourceRoot,sources:[{source_id:"raw",path:source,format:"codex",start_at:"beginning"}]};
  store.bind(binding);return {root,sourceRoot,source,state,store,binding};
}
function metadata(seed="event-1",turn="requesting-turn"):HookMetadata{return{hook_event_name:"PreCompact",native_session_id:"session-1",native_turn_id:turn,transcript_path:null,input_sha256:sha(seed),delivery_id:null};}
function enqueue(s:ReturnType<typeof setup>,seed?:string){return s.store.enqueue(s.binding,metadata(seed));}
function spawnCLI(state:string,args:string[],stdin?:string,env:Record<string,string>={}){
  return Bun.spawn([process.execPath,cli,"--state",state,...args],{stdin:stdin===undefined?"ignore":new Blob([stdin]),stdout:"pipe",stderr:"pipe",env:{...process.env,...env}});
}
async function cliResult(state:string,args:string[],stdin?:string,env?:Record<string,string>){const child=spawnCLI(state,args,stdin,env);const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{out,err,code};}
afterEach(()=>{for(const store of stores.splice(0))try{store.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe("durable binding, jobs and records",()=>{
  test("private WAL store and duplicate Hook enqueue survive reopening",()=>{
    const s=setup();expect(statSync(s.state).mode&0o077).toBe(0);expect(statSync(join(s.state,"store.sqlite")).mode&0o077).toBe(0);
    const first=enqueue(s);expect(enqueue(s).duplicate).toBe(true);const reopened=new Store(s.state);stores.push(reopened);
    expect(reopened.storeId).toBe(s.store.storeId);expect((reopened.status().jobs as any[])[0].count).toBe(1);
    expect((reopened.resolve(s.store.link("windows",first.window_id)).items as any[])[0].window_id).toBe(first.window_id);
    expect((reopened.db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
  });
  test("identical native callback at a later source ceiling creates a new logical observation",async()=>{
    const s=setup('{"type":"message","entry_id":"first"}\n');const payload={hook_event_name:"PreCompact",session_id:"session-1",turn_id:"same-turn"};
    const first=handleHook(s.store,"codex","test",payload);expect(handleHook(s.store,"codex","test",payload).disposition).toBe("duplicate");
    appendFileSync(s.source,'{"type":"message","entry_id":"second"}\n');const second=handleHook(s.store,"codex","test",payload);
    expect(second.disposition).toBe("enqueued");expect(second.window_id).not.toBe(first.window_id);await drain(s.store,options);
    expect(s.store.query({kind:"records",filters:{window_id:second.window_id!},fields:["native.entry_id"]}).items).toEqual([{"native.entry_id":"second"}]);
  });
  test("new bindings default to complete EOF, historical replay is explicit",async()=>{
    const s=setup();s.store.unbind(s.binding.binding_id);
    const b={...s.binding,binding_id:"observe-new",task_id:"new-task",sources:[{source_id:"raw",path:s.source,format:"codex" as const}]};s.store.bind(b);
    const cursor=(s.store.db.query("SELECT cursor FROM source_states WHERE binding_id=?").get(b.binding_id) as any).cursor;expect(cursor).toBe(statSync(s.source).size);
    appendFileSync(s.source,'{"type":"message","entry_id":"new-entry","text":"only new"}\n');
    const window=s.store.enqueue(b,metadata());await drain(s.store,options);
    const result=s.store.query({kind:"records",filters:{window_id:window.window_id},fields:["native.turn_id","native.session_id","native.entry_id"]});
    expect(result.items).toEqual([{"native.turn_id":null,"native.session_id":null,"native.entry_id":"new-entry"}]);
  });
  test("default EOF keeps a pre-bind partial tail pending and rejects a mid-record explicit offset",()=>{
    const s=setup('{"type":"message"}\n{"incomplete":');s.store.unbind(s.binding.binding_id);
    const b={...s.binding,binding_id:"new",sources:[{...s.binding.sources[0],start_at:"new" as const}]};s.store.bind(b);
    expect((s.store.db.query("SELECT cursor FROM source_states WHERE binding_id='new'").get() as any).cursor).toBe('{"type":"message"}\n'.length);
    s.store.unbind(b.binding_id);expect(()=>s.store.bind({...b,binding_id:"bad",sources:[{...b.sources[0],start_at:3}]})).toThrow("offset_not_record_boundary");
  });
  test("expired lease is reclaimed, previous token fenced before any record or cursor write",()=>{
    const s=setup();enqueue(s);const first=s.store.claim("old",1000,1000)!;expect(s.store.claim("new",1000,1500)).toBeNull();
    const next=s.store.claim("new",1000,2001)!;expect(next.generation).toBe(2);expect(next.lease_token).not.toBe(first.lease_token);
    const empty:Page={schema_version:"ultrafast-atif.page.v1",records:[],next_offset:0,eof:true,incomplete_tail:false,omissions:[]};
    expect(()=>s.store.finishPage(first,empty,0,0,"{}",true,2100)).toThrow("stale_worker_fenced");
    expect(s.store.renew(first,1000,2100)).toBe(false);s.store.finishUnchanged(next,2100);
  });
  test("same-source claims serialize and global cap never exceeds 32",()=>{
    const s=setup();enqueue(s,"a");enqueue(s,"b");const a=s.store.claim("one",1000,1000,32)!;expect(s.store.claim("two",1000,1000,32)).toBeNull();
    for(let i=0;i<35;i++){
      const b={...s.binding,binding_id:"cap-binding-"+i,task_id:"task-"+i,native_session_id:"session-"+i,profile:"other-"+i};s.store.bind(b);s.store.enqueue(b,{...metadata("x"+i),native_session_id:b.native_session_id});
    }
    let claimed=1;while(s.store.claim("p",1000,1000,32))claimed++;expect(claimed).toBe(32);
    expect(()=>s.store.claim("bad",1000,1000,33)).toThrow("invalid_integer");expect(()=>workerOptions({...options,concurrency:33})).toThrow("invalid_integer");
    expect(a.generation).toBe(1);
  });
  test("paged ingest resumes without copying requesting turn onto old or unknown rows",async()=>{
    const s=setup();const win=enqueue(s);const result=await drain(s.store,options);expect(result.outcomes).toEqual({continued:1,succeeded:1});
    const page=s.store.query({kind:"records",filters:{window_id:win.window_id},fields:["kind","native.turn_id"],limit:10});
    expect((page.items as any[]).find(r=>r.kind==="turn")["native.turn_id"]).toBe("old-turn");
    expect((page.items as any[]).find(r=>r.kind==="message")["native.turn_id"]).toBeNull();
    expect(JSON.stringify(page)).not.toContain("requesting-turn");expect(JSON.stringify(page)).not.toContain("PRIVATE_TEST_BODY");
    expect((s.store.query({kind:"records",filters:{native_turn_id:"requesting-turn"}}).items as any[]).length).toBe(0);
    expect((s.store.query({kind:"records",filters:{hook_turn_id:"requesting-turn"}}).items as any[]).length).toBe(3);
  });
  test("partial JSONL tail resumes on a later hook with a distinct exact window",async()=>{
    const s=setup('{"type":"message","entry_id":"one"}\n{"type":"message","entry_id":"two"');
    const w1=enqueue(s,"one");await drain(s.store,options);
    expect((s.store.query({kind:"records",filters:{window_id:w1.window_id}}).items as any[]).length).toBe(1);
    appendFileSync(s.source,'}\n');const w2=enqueue(s,"two");await drain(s.store,options);
    expect((s.store.query({kind:"records",filters:{window_id:w2.window_id},fields:["native.entry_id"]}).items as any[])[0]["native.entry_id"]).toBe("two");
    expect((s.store.query({kind:"records",filters:{window_id:w1.window_id}}).items as any[]).length).toBe(1);
  });
  test("queued extraction cannot sweep a later append into the earlier hook window",async()=>{
    const s=setup('{"type":"message","entry_id":"before-hook"}\n');const old=enqueue(s,"old");
    appendFileSync(s.source,'{"type":"message","entry_id":"after-hook"}\n');const later=enqueue(s,"later");await drain(s.store,options);
    expect(s.store.query({kind:"records",filters:{window_id:old.window_id},fields:["native.entry_id"]}).items).toEqual([{"native.entry_id":"before-hook"}]);
    expect(s.store.query({kind:"records",filters:{window_id:later.window_id},fields:["native.entry_id"]}).items).toEqual([{"native.entry_id":"after-hook"}]);
  });
  test("a pre-hook partial row completed later belongs only to the later window",async()=>{
    const s=setup('{"type":"message","entry_id":"partial"');const old=enqueue(s,"old");appendFileSync(s.source,'}\n');const later=enqueue(s,"later");await drain(s.store,options);
    expect(s.store.query({kind:"records",filters:{window_id:old.window_id}}).items).toEqual([]);
    expect(s.store.query({kind:"records",filters:{window_id:later.window_id},fields:["native.entry_id"]}).items).toEqual([{"native.entry_id":"partial"}]);
  });
  test("byte paging continues within one window and oversized single rows fail explicitly",async()=>{
    const line=(id:string)=>JSON.stringify({type:"message",entry_id:id,text:"x".repeat(650)})+"\n";
    const s=setup(line("one")+line("two")+line("three"));const window=enqueue(s);await drain(s.store,{...options,pageBytes:1024});
    expect((s.store.query({kind:"records",filters:{window_id:window.window_id}}).items as any[]).length).toBe(3);
    appendFileSync(s.source,JSON.stringify({type:"message",text:"x".repeat(2100)})+"\n");enqueue(s,"oversize");await drain(s.store,{...options,pageBytes:1024});
    expect((s.store.db.query("SELECT error_code FROM jobs WHERE state='failed'").get() as any).error_code).toBe("record_exceeds_page_budget");
  });
  test("inode rotation and source truncation fail without cursor advancement",async()=>{
    const s=setup();enqueue(s);await drain(s.store,options);const cursor=(s.store.db.query("SELECT cursor FROM source_states").get() as any).cursor;
    renameSync(s.source,s.source+".old");writeFileSync(s.source,'{"type":"new"}\n');enqueue(s,"rotated");await drain(s.store,options);
    expect((s.store.db.query("SELECT error_code FROM jobs WHERE state='failed'").get() as any).error_code).toBe("source_truncated");
    expect((s.store.db.query("SELECT cursor FROM source_states").get() as any).cursor).toBe(cursor);
  });
  test("same-length replacement also fails before first job",async()=>{
    const s=setup();const original=readFileSync(s.source);renameSync(s.source,s.source+".old");writeFileSync(s.source,original);enqueue(s);await drain(s.store,options);
    expect((s.store.db.query("SELECT error_code FROM jobs").get() as any).error_code).toBe("source_rotated_or_changed");
  });
  test("forged native identity fails scalar evidence verification",async()=>{
    const s=setup();enqueue(s);await drain(s.store,{...options,helper:[process.execPath,fixture,"--fixture-mode","forged"]});
    expect((s.store.db.query("SELECT error_code FROM jobs").get() as any).error_code).toBe("native_identity_evidence_missing");
    expect((s.store.status().records as any).n).toBe(0);
  });
});

describe("bounded query, links and source security",()=>{
  test("multi-filter relations must match the same window and task",async()=>{
    const s=setup();const first=enqueue(s);await drain(s.store,{...options,pageLimit:100});
    s.store.unbind(s.binding.binding_id);const b={...s.binding,binding_id:"b2",task_id:"task-2"};s.store.bind(b);
    const second=s.store.enqueue(b,metadata("second"));await drain(s.store,{...options,pageLimit:100});
    expect((s.store.query({kind:"records",filters:{task_id:"task-1",window_id:second.window_id}}).items as any[]).length).toBe(0);
    expect((s.store.query({kind:"records",filters:{task_id:"task-1",window_id:first.window_id}}).items as any[]).length).toBe(3);
  });
  test("queries reject unknown fields, SQL operators and null filters; values stay parameterized",async()=>{
    const s=setup();enqueue(s);await drain(s.store,options);
    expect(()=>s.store.query({kind:"records",fields:["body"]})).toThrow("unknown_query_field");
    expect(()=>s.store.query({kind:"records",filters:{"1=1;DROP TABLE records;--":"x"}})).toThrow("unknown_query_filter");
    expect(()=>s.store.query({kind:"records",filters:{native_turn_id:null as any}})).toThrow("invalid_string");
    expect((s.store.query({kind:"records",filters:{native_turn_id:"' OR 1=1 --"}}).items as any[]).length).toBe(0);
    expect(()=>s.store.query({kind:"records",limit:101})).toThrow("invalid_integer");
    expect(()=>s.store.query({kind:"records",offset:10001})).toThrow("invalid_integer");
  });
  test("CLI prototype-like filter keys cannot disappear into an unfiltered query",async()=>{
    const s=setup();enqueue(s);await drain(s.store,options);
    for(const key of ["__proto__","constructor","toString"]){const result=await cliResult(s.state,["query","--kind","records","--filter",key+"=unsupported-filter"]);expect(result.code).toBe(1);expect(result.out).toBe("");expect(JSON.parse(result.err).error).toBe("unknown_query_filter");}
  });
  test("deeplinks reject cross-store and arbitrary URI resolution without touching target",()=>{
    const s=setup();const e=enqueue(s);expect(s.store.resolve(s.store.link("events",e.event_id))).toBeDefined();
    for(const uri of ["file:///etc/passwd","https://example.com/raw","tcr://different/events/x",s.store.link("events",e.event_id)+"?uri=file:///etc/passwd"])
      expect(()=>s.store.resolve(uri)).toThrow("foreign_deeplink");
  });
  test("symlinks, hardlinks, credentials and roots outside bindings are rejected",()=>{
    const s=setup();s.store.unbind(s.binding.binding_id);
    const withPath=(path:string)=>({...s.binding,binding_id:"bad",sources:[{...s.binding.sources[0],path}]});
    const sym=join(s.sourceRoot,"linked.jsonl");symlinkSync(s.source,sym);expect(()=>s.store.bind(withPath(sym))).toThrow("symlink_denied");
    const hard=join(s.sourceRoot,"hard.jsonl");linkSync(s.source,hard);expect(()=>s.store.bind(withPath(hard))).toThrow("nonregular_or_aliased_file");
    rmSync(hard);const auth=join(s.sourceRoot,"auth.json");writeFileSync(auth,"{}");expect(()=>s.store.bind(withPath(auth))).toThrow("credential_path_denied");
    const outside=join(s.root,"outside.jsonl");writeFileSync(outside,"{}");expect(()=>s.store.bind(withPath(outside))).toThrow("source_outside_root");
  });
  test("unsafe state permissions and SQLite aliases are never repaired silently",()=>{
    const s=setup();chmodSync(s.state,0o755);expect(()=>new Store(s.state)).toThrow("state_not_private");chmodSync(s.state,0o700);
    const alias=join(s.root,"db-alias");linkSync(join(s.state,"store.sqlite"),alias);expect(()=>new Store(s.state)).toThrow("unsafe_database_file");rmSync(alias);
  });
  test("helper timeout and output caps are enforced independently of helper",async()=>{
    await expect(runHelper([process.execPath,fixture,"--fixture-mode","slow"],workerOptions({...options,timeoutMs:100}))).rejects.toThrow("helper_deadline_exceeded");
    await expect(runHelper([process.execPath,fixture,"--fixture-mode","spew"],workerOptions({...options,stdoutBytes:1024}))).rejects.toThrow("helper_output_budget_exceeded");
  });
  test("owned helper process-group deadline also handles a descendant holding stdout open",async()=>{
    const code='const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});process.exit(0)';
    const began=performance.now();await expect(runHelper([process.execPath,"-e",code],workerOptions({...options,timeoutMs:150}))).rejects.toThrow("helper_deadline_exceeded");expect(performance.now()-began).toBeLessThan(1500);
  });
  test("successful helper close also cleans ignored-stdio descendants in its owned group",async()=>{
    const code='const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.unref();console.log(JSON.stringify({child_pid:child.pid}));';
    const result=await runHelper([process.execPath,"-e",code],workerOptions(options)) as {child_pid:number};
    let exists=true;try{process.kill(result.child_pid,0);}catch(e:any){exists=e?.code!=="ESRCH";}expect(exists).toBe(false);
  });
  test("child environment preserves routing and OS context while excluding parent identities and model keys",()=>{
    const env=childEnvironment("worker",{HOME:"/private/synthetic",PATH:"/bin",TMPDIR:"/private/tmp",HTTPS_PROXY:"http://127.0.0.1:1234",NO_PROXY:"localhost",CODEX_HOME:"do-not-inherit",CODEX_THREAD_ID:"secret-thread",OPENROUTER_API_KEY:"secret",OPENAI_API_KEY:"secret"});
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1234");expect(env.HOME).toBe("/private/synthetic");expect(env.CODEX_HOME).toBeUndefined();expect(env.CODEX_THREAD_ID).toBeUndefined();expect(env.OPENROUTER_API_KEY).toBeUndefined();expect(env.TASK_CHECKPOINT_RECORD_ROLE).toBe("worker");
  });
  test("path metacharacters are literal argv and cannot execute shell substitutions",async()=>{
    const s=setup();s.store.unbind(s.binding.binding_id);const tricky=join(s.sourceRoot,"$(touch PWNED); weird.jsonl");renameSync(s.source,tricky);
    const b={...s.binding,binding_id:"tricky",sources:[{...s.binding.sources[0],path:tricky}]};s.store.bind(b);s.store.enqueue(b,metadata());await drain(s.store,options);
    expect((s.store.status().records as any).n).toBe(3);expect(existsSync(resolve("PWNED"))).toBe(false);
  });
});

describe("native Hook contracts and explicit lifecycle",()=>{
  test("observer roles, child hooks, recursion and unbound sessions are inert",()=>{
    const s=setup();const p={hook_event_name:"Stop",session_id:"session-1",turn_id:"turn"};
    expect(handleHook(s.store,"codex","test",p,"observer").disposition).toBe("suppressed_role");
    expect(handleHook(s.store,"codex","test",{...p,agent_id:"child"}).disposition).toBe("suppressed_subagent");
    expect(handleHook(s.store,"codex","test",{...p,stop_hook_active:true}).disposition).toBe("suppressed_recursion");
    expect(handleHook(s.store,"codex","test",{...p,session_id:"unbound"}).disposition).toBe("unbound");
    expect((s.store.status().jobs as any[]).length).toBe(0);
  });
  test("session lifecycle never invents turn, recall only uses supported outputs",()=>{
    const s=setup();const common={session_id:"session-1",turn_id:"bogus-supplied",prompt:"PRIVATE_PROMPT"};
    const start=handleHook(s.store,"codex","test",{...common,hook_event_name:"SessionStart"});
    expect((start.output.hookSpecificOutput as any).hookEventName).toBe("SessionStart");
    for(const event of ["Stop","Interrupt","SessionEnd","PostCompact"]){const result=handleHook(s.store,"codex","test",{...common,hook_event_name:event});expect(result.output).toEqual({});}
    const lifecycle=s.store.query({kind:"events",filters:{hook_event_name:"SessionStart"},fields:["native_turn_id"]});expect(lifecycle.items).toEqual([{native_turn_id:null}]);
    expect(JSON.stringify(s.store.status())).not.toContain("PRIVATE_PROMPT");expect(readFileSync(join(s.state,"store.sqlite-wal")).includes(Buffer.from("PRIVATE_PROMPT"))).toBe(false);
  });
  test("telemetry correlation is explicit, typed and never derived from session identity",()=>{
    const s=setup();const payload={hook_event_name:"PreCompact",session_id:"session-1",turn_id:"turn"};handleHook(s.store,"codex","test",payload);
    const absent=s.store.query({kind:"events",fields:["telemetry.source","telemetry.trace_id","telemetry.span_id"]});expect(absent.items).toEqual([{"telemetry.source":"unavailable","telemetry.trace_id":null,"telemetry.span_id":null}]);
    const t={namespace:"opentelemetry.w3c",source:"explicit_adapter",trace_id:"a".repeat(32),span_id:"b".repeat(16)};
    handleHook(s.store,"codex","test",{...payload,task_checkpoint_record_telemetry:t});
    expect((s.store.query({kind:"events",filters:{trace_id:t.trace_id},fields:["telemetry.source"]}).items as any[]).length).toBe(1);
    expect(()=>handleHook(s.store,"codex","test",{...payload,task_checkpoint_record_telemetry:{...t,trace_id:"session-1"}})).toThrow("invalid_telemetry_id");
    expect(()=>handleHook(s.store,"codex","test",{...payload,task_checkpoint_record_telemetry:{...t,trace_id:"0".repeat(32)}})).toThrow("invalid_telemetry_id");
  });
  test("Claude prompt IDs and Pi turn indexes remain outside native turn identity",()=>{
    const s=setup();s.store.unbind(s.binding.binding_id);
    for(const client of ["claude","pi"] as const){
      const b={...s.binding,binding_id:client,client};s.store.bind(b);
      handleHook(s.store,client,"test",{schema_version:"task-checkpoint-record.pi-hook.v1",hook_event_name:client==="pi"?"turn_end":"UserPromptSubmit",session_id:"session-1",prompt_id:"prompt",turnIndex:4,turn_id:"not-a-verified-native-field"});
      const events=s.store.query({kind:"events",filters:{client},fields:["native_turn_id"]});expect(events.items).toEqual([{native_turn_id:null}]);s.store.unbind(client);
    }
  });
  test("Hook CLI returns {} on invalid input with bounded error and no blocking exit",async()=>{
    const s=setup();const invalid=await cliResult(s.state,["hook","--client","codex","--profile","test"],"not json");
    expect(invalid.code).toBe(0);expect(invalid.out.trim()).toBe("{}");expect(invalid.err.length).toBeLessThan(300);expect(JSON.parse(invalid.err).enqueued).toBe(false);
    const huge=await cliResult(s.state,["hook","--client","codex","--profile","test"],JSON.stringify({prompt:"x".repeat(100000)}));expect(huge.out.trim()).toBe("{}");expect(huge.code).toBe(0);
  });
  test("CLI once extracts, exact queries resolve, and no daemon is started by ingress",async()=>{
    const s=setup();const begin=performance.now();const hook=await cliResult(s.state,["hook","--client","codex","--profile","test"],JSON.stringify({hook_event_name:"SessionEnd",session_id:"session-1"}));
    expect(hook.code).toBe(0);expect(hook.out.trim()).toBe("{}");expect(performance.now()-begin).toBeLessThan(1000);
    expect((s.store.status().services as any[]).length).toBe(0);
    const once=await cliResult(s.state,["service","once","--helper",process.execPath,"--helper-arg",fixture]);expect(once.code).toBe(0);
    const query=await cliResult(s.state,["query","--kind","records","--fields","record_id,deeplink","--limit","1"]);const result=JSON.parse(query.out);expect(result.items.length).toBe(1);expect(result.next_offset).toBe(1);
    const resolveResult=await cliResult(s.state,["resolve","--link",result.items[0].deeplink]);expect(resolveResult.code).toBe(0);expect(JSON.stringify(JSON.parse(resolveResult.out))).not.toContain("PRIVATE_TEST_BODY");
  });
  test("CLI schemas are JSON and require no state initialization",async()=>{
    const child=Bun.spawn([process.execPath,cli,"schema","query"],{stdout:"pipe",stderr:"pipe"});const text=await new Response(child.stdout).text();expect(await child.exited).toBe(0);const schema=JSON.parse(text);expect(schema.$schema).toContain("2020-12");expect(schema.oneOf.length).toBe(4);
  });
  test("explicit detached service start/stop leaves master process and source intact",async()=>{
    const s=setup();enqueue(s);const started=await cliResult(s.state,["service","start","--helper",process.execPath,"--helper-arg",fixture]);expect(started.code).toBe(0);
    const deadline=Date.now()+3000;while((s.store.status().records as any).n!==3&&Date.now()<deadline)await Bun.sleep(25);
    expect((s.store.status().records as any).n).toBe(3);const stopped=await cliResult(s.state,["service","stop"]);expect(JSON.parse(stopped.out).stop_requested).toBe(true);
    let ended=false;for(let i=0;i<40;i++){if((s.store.status().services as any[])[0]?.state==="stopped"){ended=true;break;}await Bun.sleep(25);}expect(ended).toBe(true);expect(existsSync(s.source)).toBe(true);
  });
  test("checkpoint import exposes deliberately limited validation and never follows artifact URIs",()=>{
    const s=setup();const file=join(s.root,"event.json");const event={schema_version:"task-turns-checkpoint.v1",event_type:"task_turns_checkpoint",event_id:"cp:one",task:{task_id:"task-1"},facets:{native_sessions:[{client:"codex",roles:["primary_actor"],native_session_id:{status:"observed",value:"session-1"}}]},privacy:{visibility:"private",access_scope:"local_user",content:"metadata_only"},checkpoint_ref:{record_id:"owner",uri:"file:///MISSING/owner.json",sha256:"0".repeat(64),json_pointer:""},provenance_ref:{record_id:"lineage",uri:"https://invalid.test/never-follow",sha256:"0".repeat(64),json_pointer:""},unexpected_body:"MUST_NOT_STORE"};
    writeFileSync(file,JSON.stringify(event));const result=s.store.importCheckpoint("binding-1",file);expect(result.validation_level).toContain("not_full_schema");expect(JSON.stringify(result)).not.toContain("MUST_NOT_STORE");expect(s.store.importCheckpoint("binding-1",file).checkpoint_id).toBe(result.checkpoint_id);
    event.task.task_id="other";writeFileSync(file,JSON.stringify(event));expect(()=>s.store.importCheckpoint("binding-1",file)).toThrow("checkpoint_task_mismatch");
  });
});

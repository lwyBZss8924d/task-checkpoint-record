import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runAppServerTask, type AppServerTaskOptions } from "../src/appserver.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
type Answer = { ok: boolean };
const outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const validateOutput = (value: unknown): Answer => {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || typeof (value as Answer).ok !== "boolean") throw new Error("invalid");
  return value as Answer;
};

async function fixture(mode = "success", limits: AppServerTaskOptions<Answer>["limits"] = {}, userAgent = "codex_cli_rs/0.157.1 (Darwin)") {
  const dir = await mkdtemp(join(tmpdir(), "task-record-appserver-")); dirs.push(dir);
  const home = join(dir, ".codex-task-checkpoint-record"); await mkdir(home);
  const executable = join(dir, "fake-codex"); const log = join(dir, "requests.jsonl");
  // A real child with JSONL stdio exercises framing, IPC and ownership without Codex or a model.
  const script = `#!${process.execPath}\n` + String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const mode = MODE, log = LOG, userAgent = USER_AGENT;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const thread = "thread-native", turn = "turn-native";
let initialized = false, model, effort;
const finish = () => {
  send({method:"item/reasoning/textDelta",params:{threadId:thread,turnId:turn,delta:"SECRET_REASONING_DO_NOT_RETAIN"}});
  send({method:"item/completed",params:{threadId:"another-thread",turnId:turn,item:{type:"agentMessage",id:"foreign",phase:"final_answer",text:'{"ok":false}'}}});
  send({method:"turn/completed",params:{threadId:thread,turn:{id:"another-turn",status:"failed",items:[]}}});
  if(mode === "tool") send({method:"item/started",params:{threadId:thread,turnId:turn,item:{type:"commandExecution",id:"cmd"}}});
  const item = {type:"agentMessage",id:"final",phase:mode === "no-final"?"commentary":"final_answer",text:mode === "bad-output"?'{"ok":"wrong"}':mode === "not-json"?'oops':mode === "large-output"?'x'.repeat(20000):'{"ok":true}'};
  send({method:"item/completed",params:{threadId:thread,turnId:turn,item}});
  send({method:"thread/tokenUsage/updated",params:{threadId:thread,turnId:turn,tokenUsage:{last:{totalTokens:20,inputTokens:10,cachedInputTokens:2,outputTokens:10,reasoningOutputTokens:5,unexpected:"SECRET_USAGE"}}}});
  if(mode === "terminal-conflict") send({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:"failed",items:[]}}});
  send({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:mode==="failed"?"failed":"completed",items:[item]}}});
  if(mode === "duplicate-completion") send({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:"completed",items:[item]}}});
  if(mode === "late-terminal-conflict") setTimeout(()=>send({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:"failed",items:[]}}}),10);
};
if (mode === "close") process.exit(0);
if (mode === "ignore-eof") process.stdin.on("end", () => setInterval(() => {},1000));
createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ ...m, env:m.method==="initialize"?{pid:process.pid,home:process.env.CODEX_HOME,worker:process.env.TASK_CHECKPOINT_RECORD_WORKER,role:process.env.TASK_CHECKPOINT_RECORD_ROLE,apiKeyPresent:!!process.env.OPENAI_API_KEY,args:process.argv.slice(2)}:undefined})+"\n");
  if (m.method === "initialized") { initialized = true; return; }
  if (m.method === "initialize") {
    if(mode === "malformed") { process.stdout.write("{bad\n"); return; }
    if(mode === "partial-tail") { process.stdout.write('{"id":'); return; }
    if(mode === "stderr") { process.stderr.write("x".repeat(20000)); return; }
    if(mode === "wire") { process.stdout.write("x".repeat(20000)); return; }
    const result = {id:m.id,result:{userAgent:mode==="version"?"codex_cli_rs/0.999.0":userAgent}};
    if(mode === "partial") { const text=JSON.stringify(result)+"\n"; process.stdout.write(text.slice(0,13)); setTimeout(()=>process.stdout.write(text.slice(13)),5); }
    else send(result);
    return;
  }
  if (!initialized) { send({id:m.id,error:{code:-1,message:"bad order"}}); return; }
  if (m.method === "account/read") {
    send({id:m.id,result:{requiresOpenaiAuth:true,account:mode==="unauth"?null:{type:mode==="api-auth"?"apiKey":"chatgpt",email:"PRIVATE_EMAIL_DO_NOT_RETAIN"}}}); return;
  }
  if (m.method === "model/list") {
    send({id:m.id,result:{data:mode==="unavailable"?[]:[...['gpt-6-sol','gpt-6-luna'].map(model=>({model,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}))],nextCursor:null}}); return;
  }
  if (m.method === "thread/start") {
    model=m.params.model; effort=m.params.config.model_reasoning_effort;
    if(mode === "rpc-error") {send({id:m.id,error:{code:-2,message:"PRIVATE_RPC_ERROR"}});return;}
    const path=process.env.CODEX_HOME+'/sessions/synthetic.jsonl';
    if(mode==="rollout") { mkdirSync(process.env.CODEX_HOME+'/sessions'); writeFileSync(path,'synthetic fixture, not a real rollout'); }
    send({id:m.id,result:{thread:{id:thread,sessionId:"session-distinct",ephemeral:false,path:mode==="rollout"||mode==="future-rollout"?path:null},model:mode==="wrong-model"?"other":model,reasoningEffort:mode==="wrong-effort"?"low":effort,modelProvider:"openai",cwd:m.params.cwd,approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false}}}); return;
  }
  if (m.method === "turn/start") {
    if(mode === "approval") { send({id:"server-approval",method:"item/commandExecution/requestApproval",params:{threadId:thread,turnId:turn}}); return; }
    if(mode === "early") { finish(); send({id:m.id,result:{turn:{id:turn,status:"inProgress",items:[]}}}); return; }
    if(mode === "orphan-descendant") {
      const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
      descendant.unref(); appendFileSync(log,JSON.stringify({descendantPid:descendant.pid})+"\n");
    }
    send({id:m.id,result:{turn:{id:turn,status:"inProgress",items:[]}}});
    if(mode === "timeout" || mode === "cancel") return;
    setTimeout(finish,5); return;
  }
  if (m.method === "turn/interrupt") { send({id:m.id,result:{}}); }
});
`.replace("MODE", JSON.stringify(mode)).replace("LOG", JSON.stringify(log)).replace("USER_AGENT", JSON.stringify(userAgent));
  await writeFile(executable, script); await chmod(executable, 0o700);
  const options: AppServerTaskOptions<Answer> = { codexExecutable: executable, codexHome: home, cwd: dir,
    input: { dataClass: "synthetic", text: "A synthetic source record. Return {ok:true}." }, outputSchema, validateOutput,
    limits: { deadlineMs: 2000, shutdownMs: 50, ...limits } };
  return { options, dir, home, log, requests: async () => (await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line)) };
}

describe("owned Codex App Server adapter", () => {
  test.each(["0.157.1", "0.158.0"])("explicit supported native version %s is observed in the result", async version => {
    const f = await fixture("success", {}, `task_checkpoint_record/${version} (Darwin; fixture)`);
    const result = await runAppServerTask(f.options);
    expect(result.runtime.protocolVersion).toBe(`codex-${version}` as "codex-0.157.1" | "codex-0.158.0");
    expect(result.output).toEqual({ ok: true });
  });
  test.each([
    "codex_cli_rs/0.157.0 (Darwin)", "codex_cli_rs/0.158.1 (Darwin)",
    "codex_cli_rs/0.159.0 (Darwin)", "codex_cli_rs/0.158.0-alpha.1 (Darwin)",
    "codex_cli_rs/0.999.0 (compatibility 0.158.0)", "unknown 0.157.1",
  ])("unsupported or misleading native version is rejected: %s", async userAgent => {
    const f = await fixture("success", {}, userAgent);
    await expect(runAppServerTask(f.options)).rejects.toMatchObject({ code: "unsupported_codex_version" });
    expect((await f.requests()).map(r => r.method)).toEqual(["initialize"]);
  });
  test.each(["success", "partial", "early", "ignore-eof", "duplicate-completion"])("%s: handshake, native IDs, bounded output and owned cleanup", async mode => {
    const f = await fixture(mode); const result = await runAppServerTask(f.options);
    expect(result.output).toEqual({ok:true}); expect(result.native).toEqual({threadId:"thread-native",turnId:"turn-native",sessionId:"session-distinct",rollout:{path:null,state:"unavailable",contentBindingVerified:false}});
    expect(result.runtime.ownedProcessClosed).toBe(true);
    expect(result.runtime.ownedProcessGroupClosed).toBe(process.platform === "win32" ? null : true);
    expect(result.requested).toEqual({model:"gpt-6-sol",effort:"medium"});
    expect(result.usage).toEqual({totalTokens:20,inputTokens:10,cachedInputTokens:2,outputTokens:10,reasoningOutputTokens:5});
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_EMAIL/);
    const calls = await f.requests();
    expect(calls.map(c=>c.method)).toEqual(["initialize","initialized","account/read","model/list","thread/start","turn/start"]);
    expect(calls[0].env.home).toBe(await realpath(f.home));
    expect(calls[0].env.worker).toBe("1"); expect(calls[0].env.apiKeyPresent).toBe(false);
    expect(calls[0].env.role).toBe("worker");
    expect(() => process.kill(calls[0].env.pid,0)).toThrow();
    expect(calls[0].env.args).toContain("features.code_mode=false");
    expect(calls[4].params.environments).toEqual([]); expect(calls[5].params.environments).toEqual([]);
    expect(calls[4].params.ephemeral).toBe(false);
    expect(calls[4].params.allowProviderModelFallback).toBe(false);
    expect(calls[4].params.config["features.hooks"]).toBe(false);
    expect(calls[5].params.effort).toBe("medium");
  });
  test.each(["terminal-conflict","late-terminal-conflict"])("%s cannot overwrite a terminal state",async mode=>{
    const f=await fixture(mode);
    let code:string|undefined;
    try { await runAppServerTask(f.options); } catch(error) { code=(error as {code:string}).code; }
    expect(["conflicting_turn_completion","turn_not_completed"]).toContain(code!);
  });
  test.skipIf(process.platform === "win32")("a same-group ignored-stdio descendant is closed without killing another owned group",async()=>{
    const f=await fixture("orphan-descendant");
    const unrelated=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
    const unrelatedClosed=new Promise<void>(resolve=>unrelated.once("close",()=>resolve()));
    let descendantPid:number|undefined;
    try {
      const result=await runAppServerTask(f.options);
      const requests=await f.requests();descendantPid=requests.find(r=>r.descendantPid)?.descendantPid;
      expect(typeof descendantPid).toBe("number");
      expect(result.runtime.ownedProcessGroupClosed).toBe(true);
      expect(()=>process.kill(descendantPid!,0)).toThrow();
      expect(()=>process.kill(unrelated.pid!,0)).not.toThrow();
    } finally {
      // Fixture cleanup is restricted to the two processes created by this test.
      if(descendantPid)try{process.kill(descendantPid,"SIGKILL");}catch{}
      unrelated.kill("SIGTERM");await unrelatedClosed;
    }
  });
  test.each([["rollout","regular_file_verified"],["future-rollout","observed_not_verified"]] as const)("%s path observation has no inferred content binding",async(mode,state)=>{
    const f=await fixture(mode); const result=await runAppServerTask(f.options);
    expect(result.native.rollout).toEqual({path:join(await realpath(f.home),"sessions/synthetic.jsonl"),state,contentBindingVerified:false});
  });
  test.each([
    ["semantic-worker","gpt-6-luna","medium"], ["eval","gpt-6-luna","high"],
  ] as const)("%s model policy is sent exactly", async (role, model, effort) => {
    const f = await fixture(); const result = await runAppServerTask({...f.options,role});
    expect(result.requested).toEqual({model,effort});
    const requests=await f.requests(); expect(requests.find(r=>r.method==="turn/start").params).toMatchObject({model,effort});
  });
  test.each([
    ["unauth","dedicated_chatgpt_login_required"], ["api-auth","dedicated_chatgpt_login_required"],
    ["unavailable","requested_model_or_effort_unavailable"], ["wrong-model","model_selection_not_honored"],
    ["wrong-effort","model_selection_not_honored"], ["version","unsupported_codex_version"],
    ["rpc-error","rpc_error"], ["approval","server_request_rejected"], ["tool","tool_or_unexpected_item"],
    ["bad-output","output_validation_failed"], ["not-json","output_validation_failed"],
    ["no-final","final_output_unavailable"], ["failed","turn_not_completed"],
    ["malformed","invalid_rpc_message"], ["close","server_closed"],
  ])("%s fails closed without exposing source errors", async (mode, code) => {
    const f=await fixture(mode); await expect(runAppServerTask(f.options)).rejects.toMatchObject({name:"AppServerError",code,message:code});
    if(mode==="unauth" || mode==="api-auth") expect((await f.requests()).some(r=>r.method==="thread/start")).toBe(false);
    if(mode==="approval") expect((await f.requests()).find(r=>r.id==="server-approval").error.code).toBe(-32601);
  });
  test("deadline interrupts only observed owned turn and closes process", async()=>{
    const f=await fixture("timeout",{deadlineMs:200}); const start=Date.now();
    await expect(runAppServerTask(f.options)).rejects.toMatchObject({code:"deadline_exceeded"});
    expect(Date.now()-start).toBeLessThan(1000);
    expect((await f.requests()).find(r=>r.method==="turn/interrupt").params).toEqual({threadId:"thread-native",turnId:"turn-native"});
  });
  test("abort signal cancels an owned turn", async()=>{
    const f=await fixture("cancel"); const controller=new AbortController();
    const pending=runAppServerTask({...f.options,signal:controller.signal});
    const timer=setTimeout(()=>controller.abort(),150);
    await expect(pending).rejects.toMatchObject({code:"cancelled"}); clearTimeout(timer);
    expect((await f.requests()).some(r=>r.method==="turn/interrupt")).toBe(true);
  });
  test.each([
    ["partial-tail",{deadlineMs:150},"deadline_exceeded"], ["wire",{maxWireBytes:1024},"wire_limit"],
    ["wire",{maxLineBytes:256},"line_limit"], ["stderr",{maxStderrBytes:1024},"stderr_limit"],
    ["large-output",{maxOutputBytes:256},"output_limit"],
  ] as const)("%s bounded failure", async (mode,limits,code)=>{
    const f=await fixture(mode,limits); await expect(runAppServerTask(f.options)).rejects.toMatchObject({code});
  });
  test("RAW labels, relative paths, cancelled starts and default-home aliases cannot launch",async()=>{
    const f=await fixture();
    await expect(runAppServerTask({...f.options,input:{dataClass:"raw" as "synthetic",text:"private"}})).rejects.toMatchObject({code:"prepared_input_required"});
    await expect(runAppServerTask({...f.options,cwd:"."})).rejects.toMatchObject({code:"absolute_paths_required"});
    await expect(runAppServerTask({...f.options,signal:AbortSignal.abort()})).rejects.toMatchObject({code:"cancelled"});
    const alias=join(f.dir,"alias"); await symlink(homedir(),alias);
    await expect(runAppServerTask({...f.options,codexHome:alias})).rejects.toMatchObject({code:"dedicated_codex_home_required"});
    await expect(readFile(f.log)).rejects.toMatchObject({code:"ENOENT"});
  });
  test.each([".codex", ".codex-test"])("direct API rejects %s/..service before launching any process",async protectedName=>{
    const f=await fixture();
    const isolatedHome=join(f.dir,"synthetic-user-home");
    const protectedDescendant=join(isolatedHome,protectedName,"..service");
    await mkdir(protectedDescendant,{recursive:true});
    const options={...f.options,codexHome:protectedDescendant};
    const runner=`import {runAppServerTask} from ${JSON.stringify(new URL("../src/appserver.ts",import.meta.url).href)};
      try { await runAppServerTask({...${JSON.stringify(options)},validateOutput:value=>value});
        process.stdout.write(JSON.stringify({status:"accepted"}));
      } catch(error) { process.stdout.write(JSON.stringify({status:"rejected",code:error.code})); }`;
    // A separate synthetic user context avoids changing this process's HOME or
    // touching the operator's real protected Codex homes.
    const child=Bun.spawn([process.execPath,"--eval",runner],{
      cwd:f.dir,env:{HOME:isolatedHome,PATH:process.env.PATH??""},stdin:"ignore",stdout:"pipe",stderr:"pipe",
    });
    const timer=setTimeout(()=>child.kill(),3000);
    try{
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code).toBe(0);expect(err).toBe("");
      expect(JSON.parse(out)).toEqual({status:"rejected",code:"dedicated_codex_home_required"});
      await expect(readFile(f.log)).rejects.toMatchObject({code:"ENOENT"});
    }finally{clearTimeout(timer);}
  });
  test("direct API accepts a real sibling of protected homes in an isolated user context",async()=>{
    const f=await fixture();const isolatedHome=join(f.dir,"synthetic-user-home");
    await mkdir(join(isolatedHome,".codex"),{recursive:true});
    await mkdir(join(isolatedHome,".codex-test"));
    const sibling=join(isolatedHome,".codex-task-checkpoint-record");await mkdir(sibling);
    const runner=`import {runAppServerTask} from ${JSON.stringify(new URL("../src/appserver.ts",import.meta.url).href)};
      const result=await runAppServerTask({...${JSON.stringify({...f.options,codexHome:sibling})},validateOutput:value=>value});
      process.stdout.write(JSON.stringify({output:result.output,home:result.runtime.codexHome}));`;
    const child=Bun.spawn([process.execPath,"--eval",runner],{
      cwd:f.dir,env:{HOME:isolatedHome,PATH:process.env.PATH??""},stdin:"ignore",stdout:"pipe",stderr:"pipe",
    });
    const timer=setTimeout(()=>child.kill(),3000);
    try{
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code).toBe(0);expect(err).toBe("");
      expect(JSON.parse(out)).toEqual({output:{ok:true},home:await realpath(sibling)});
      expect((await f.requests()).some(r=>r.method==="turn/start")).toBe(true);
    }finally{clearTimeout(timer);}
  });
});

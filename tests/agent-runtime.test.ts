import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, runAgentTurn, AgentRuntimeError, type AgentSession, type AgentSessionOptions, type AgentTool } from "../src/agent-runtime.ts";
import { fixtureQualifiedRuntime } from "./fixture-qualified-runtime.ts";

const roots: string[] = [], sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {});
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const schema = { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 5 } }, required: ["limit"] };
function tool(window = "window-a"): AgentTool {
  return { name: "tcr_query", description: "Read bounded metadata in this host-selected window", inputSchema: schema,
    validateArguments(value) {
      if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !Number.isInteger((value as any).limit) || (value as any).limit < 1 || (value as any).limit > 5) throw Error("invalid");
      return value;
    }, execute() { return { dataClass: "metadata_only", value: { window } }; } };
}
const request = () => ({ input: { dataClass: "synthetic" as const, text: "Inspect only the host-bound metadata and report a result." },
  outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, sequence: { type: "integer" } }, required: ["ok", "sequence"] },
  validateOutput(value: unknown) {
    if (!value || typeof value !== "object" || typeof (value as any).ok !== "boolean" || !Number.isSafeInteger((value as any).sequence)) throw Error("invalid");
    return value as { ok: boolean; sequence: number };
  } });
async function fixture(mode = "tool", userAgent = "task_checkpoint_record_agent/0.158.0 (synthetic)") {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-test-")); roots.push(root);
  const codexHome = join(root, ".codex-task-checkpoint-record"); await mkdir(codexHome);
  const executable = join(root, "fake-codex"); const log = join(root, "wire.jsonl");
  const script = `#!${process.execPath}\n` + String.raw`
import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline'; import {spawn} from 'node:child_process';
const mode=MODE,log=LOG,userAgent=USER_AGENT,send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const thread='native-resident-thread';let initialized=false,sequence=0,model,effort;
const pending=new Map();
function final(turn,success=true,extraItems=[]){
 const item={type:'agentMessage',id:'answer-'+turn,phase:'final_answer',text:JSON.stringify({ok:success,sequence})};
 const frames=[{method:'item/completed',params:{threadId:thread,turnId:turn,item}},
 {method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[...extraItems,item]}}}];
 if(mode==='conflict')frames.push({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'failed',items:[]}}});
 process.stdout.write(frames.map(x=>JSON.stringify(x)+'\n').join(''));
 if(mode==='late-conflict')setTimeout(()=>send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'failed',items:[]}}}),30);
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify({...m,...(m.method==='initialize'?{argv:process.argv.slice(2)}:{})})+'\n');
 if(m.method==='initialize'){send({id:m.id,result:{userAgent}});return;}
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized){send({id:m.id,error:{code:-1,message:'initialization ordering'}});return;}
 if(m.method==='config/read'){send({id:m.id,result:{config:{mcp_servers:mode==='mcp-config'?{unsafe:{}}:{}}}});return;}
 if(m.method==='account/read'){send({id:m.id,result:{account:mode==='no-auth'?null:{type:'chatgpt'},requiresOpenaiAuth:true}});return;}
 if(m.method==='model/list'){send({id:m.id,result:{data:mode==='no-model'?[]:['gpt-6-sol','gpt-6-luna'].map(model=>({model,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]})),nextCursor:null}});return;}
 if(m.method==='thread/start'){model=m.params.model;effort=m.params.config.model_reasoning_effort;const selected=m.params.sandbox==='danger-full-access',full=mode==='wrong-sandbox'?!selected:selected;send({id:m.id,result:{thread:{id:thread,sessionId:'native-session',ephemeral:false},model,reasoningEffort:effort,modelProvider:'openai',cwd:m.params.cwd,approvalPolicy:mode==='wrong-approval'?'on-request':'never',approvalsReviewer:'user',sandbox:full?{type:'dangerFullAccess'}:{type:'readOnly',networkAccess:mode==='wrong-network'}}});return;}
 if(m.method==='turn/start'){
  const turn='native-turn-'+(++sequence);const reply=()=>send({id:m.id,result:{turn:{id:turn,status:'inProgress',items:[]}}});
  if(mode==='wait'){reply();return;}
  if(mode==='no-tool'||mode==='conflict'||mode==='late-conflict'||mode==='orphan'){
   reply();if(mode==='orphan'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();appendFileSync(log,JSON.stringify({descendant:child.pid})+'\n');}final(turn);return;
  }
  if(mode!=='early')reply();
  const callId='call-'+sequence,rpc='request-'+sequence;
  const args=mode==='bad-args'?{limit:999,scope:'outside'}:{limit:1};
  const name=mode==='unknown-tool'?'tcr_unregistered':'tcr_query';
  pending.set(rpc,{turn,callId,name,args});
  send({method:'item/started',params:{threadId:thread,turnId:turn,item:{type:'dynamicToolCall',id:callId,tool:name,namespace:null,status:'inProgress'}}});
  const params={threadId:mode==='cross-thread'?'other-thread':thread,turnId:mode==='cross-turn'?'other-turn':turn,callId,tool:name,namespace:mode==='namespace'?'foreign':null,arguments:args};
  send({id:rpc,method:mode==='approval'?'item/commandExecution/requestApproval':'item/tool/call',params});
  if(mode==='duplicate-call')send({id:rpc+'-duplicate',method:'item/tool/call',params});
  if(mode==='burst')send({id:rpc+'-second',method:'item/tool/call',params:{...params,callId:callId+'-second'}});
  if(mode==='premature')final(turn);
  if(mode==='early')reply();return;
 }
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return;}
 const p=pending.get(m.id);
 if(p&&m.result){
  pending.delete(m.id);
  const item={type:'dynamicToolCall',id:p.callId,tool:mode.startsWith('mismatched-')?'tcr_other':p.name,namespace:null,status:m.result.success?'completed':'failed',success:m.result.success};
  if(mode==='mismatched-turn-tool'){final(p.turn,m.result.success,[item]);return;}
  send({method:'item/completed',params:{threadId:thread,turnId:p.turn,item}});final(p.turn,m.result.success);
 }
});
`.replace("MODE", JSON.stringify(mode)).replace("LOG", JSON.stringify(log)).replace("USER_AGENT", JSON.stringify(userAgent));
  await writeFile(executable, script); await chmod(executable, 0o700);
  const options: AgentSessionOptions = { codexExecutable: executable, codexHome, cwd: root, tools: [tool()],
    limits: { startupMs: 1000, deadlineMs: 2000, sessionMs: 10000, shutdownMs: 50, toolShutdownMs: 100, toolDeadlineMs: 500 } };
  return { root, log, options, messages: async () => (await readFile(log, "utf8")).trim().split("\n").map(x => JSON.parse(x)) };
}
async function create(options: AgentSessionOptions) { const session = await createAgentSession(options); sessions.push(session); return session; }

test.each([undefined,"read-only","danger-full-access"] as const)("native agent execution mode %s reaches process, thread and every turn",async mode=>{
  const f=await fixture("tool","task_checkpoint_record_agent/0.159.0 (synthetic)");
  const s=await create({...f.options,...(mode?{executionMode:mode}:{})}),expected=mode??"read-only";
  const first=await s.runTurn(request()),second=await s.runTurn(request());
  expect(s.identity.executionMode).toBe(expected);expect(s.identity.protocolVersion).toBe("codex-0.159.0");
  expect(first.runtime.executionMode).toBe(expected);expect(second.runtime.executionMode).toBe(expected);
  const calls=await f.messages(),argv=calls[0].argv;
  expect(argv).toContain(`sandbox_mode=${JSON.stringify(expected)}`);expect(argv).toContain('approval_policy="never"');
  expect(argv).not.toContain("--sandbox");expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(calls.find(c=>c.method==='thread/start').params).toMatchObject({approvalPolicy:"never",sandbox:expected,config:{sandbox_mode:expected}});
  for(const call of calls.filter(c=>c.method==='turn/start'))expect(call.params).toMatchObject({approvalPolicy:"never",sandboxPolicy:expected==='danger-full-access'?{type:"dangerFullAccess"}:{type:"readOnly",networkAccess:false}});
});
test.each(["read-only","danger-full-access"] as const)("native service rejects changed returned %s policy before a turn",async executionMode=>{
  for(const mode of ["wrong-sandbox","wrong-approval"]){const f=await fixture(mode);await expect(create({...f.options,executionMode})).rejects.toMatchObject({code:"agent_runtime_policy_not_honored"});expect((await f.messages()).some(c=>c.method==='turn/start')).toBe(false);}
});
test("full access preserves explicit tool/data admission and refuses unqualified future versions",async()=>{
  const f=await fixture("unknown-tool");const s=await create({...f.options,executionMode:"danger-full-access"});
  await expect(s.runTurn(request())).rejects.toBeInstanceOf(AgentRuntimeError);
  const unknown=await fixture("tool","task_checkpoint_record_agent/0.999.0 (synthetic)");
  await expect(create({...unknown.options,executionMode:"danger-full-access"})).rejects.toMatchObject({code:"unsupported_codex_version"});
  expect((await unknown.messages()).map(c=>c.method)).toEqual(["initialize"]);
});
test("future native agent version requires the exact qualified package and matching handshake",async()=>{
  const f=await fixture("tool","task_checkpoint_record_agent/0.999.0 (synthetic)"),qualified=fixtureQualifiedRuntime(f.options.codexExecutable);
  const s=await create({...f.options,codexExecutable:qualified.executable,qualificationPath:qualified.qualificationPath,executionMode:"danger-full-access"});
  const result=await s.runTurn(request());expect(result.runtime.protocolVersion).toBe("codex-0.999.0");
  expect(result.runtime.qualification).toEqual(s.identity.qualification);expect(result.runtime.qualification?.version).toBe("0.999.0");
  expect(result.runtime.qualification?.executableSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.runtime.qualification?.qualificationSha256).toMatch(/^[a-f0-9]{64}$/);
  const wrong=await fixture(),wrongQualified=fixtureQualifiedRuntime(wrong.options.codexExecutable);
  await expect(create({...wrong.options,codexExecutable:wrongQualified.executable,qualificationPath:wrongQualified.qualificationPath})).rejects.toMatchObject({code:"runtime_qualification_version_mismatch"});
  expect((await wrong.messages()).map(c=>c.method)).toEqual(["initialize"]);
});
test("modified qualified native bytes fail before the process starts",async()=>{
  const f=await fixture("tool","task_checkpoint_record_agent/0.999.0 (synthetic)"),qualified=fixtureQualifiedRuntime(f.options.codexExecutable);
  await writeFile(qualified.executable,(await readFile(qualified.executable,"utf8"))+"\n// changed synthetic executable\n");
  await expect(create({...f.options,codexExecutable:qualified.executable,qualificationPath:qualified.qualificationPath})).rejects.toMatchObject({code:"runtime_package_changed"});
  await expect(readFile(f.log)).rejects.toMatchObject({code:"ENOENT"});
});

test.each(["tool", "early"])("%s: resident thread handles validated tools across two separate turns", async mode => {
  const f = await fixture(mode); const s = await create(f.options); const pid = s.identity.pid;
  expect(() => s.assertHealthy()).not.toThrow();
  let observedStart: unknown;
  const first = await s.runTurn({ ...request(), onStarted: value => { observedStart = value; } });
  expect(observedStart).toEqual({ threadId: first.native.threadId, turnId: first.native.turnId, sessionId: first.native.sessionId, pid });
  const second = await s.runTurn({ ...request(), tools: [tool("window-b")] });
  expect(() => s.assertHealthy()).not.toThrow();
  expect(first.native.threadId).toBe(second.native.threadId); expect(first.native.turnId).not.toBe(second.native.turnId);
  expect(first.runtime.sessionOpen).toBe(true); expect(second.runtime.pid).toBe(pid);
  expect(first.toolReceipts[0]).toMatchObject({ tool: "tcr_query", status: "succeeded", dataClass: "metadata_only" });
  const messages = await f.messages();
  expect(messages.filter(x => x.method === "initialize")).toHaveLength(1);
  expect(messages.filter(x => x.method === "thread/start")).toHaveLength(1);
  const started = messages.find(x => x.method === "thread/start").params;
  expect(started).toMatchObject({ ephemeral: false, environments: [], selectedCapabilityRoots: [] });
  expect(started.dynamicTools[0]).toMatchObject({ type: "function", name: "tcr_query", inputSchema: schema });
  const replies = messages.filter(x => x.result?.contentItems);
  expect(JSON.parse(replies[0].result.contentItems[0].text).value.window).toBe("window-a");
  expect(JSON.parse(replies[1].result.contentItems[0].text).value.window).toBe("window-b");
  expect(() => process.kill(pid, 0)).not.toThrow();
  const closed = await s.close(); expect(closed).toMatchObject({ ownedProcessClosed: true, hostHandlersSettled: true, turnsStarted: 2 });
  expect(await s.closed).toEqual(closed); expect(() => process.kill(pid, 0)).toThrow();
  expect(() => s.assertHealthy()).toThrow("agent_session_closed");
});
test("invalid arguments return bounded tool failure without executing handler", async () => {
  const f = await fixture("bad-args"); let executed = false;
  const t = tool(); t.execute = () => { executed = true; throw Error("should not run"); };
  const s = await create({ ...f.options, tools: [t] }); const result = await s.runTurn(request());
  expect(executed).toBe(false); expect(result.output.ok).toBe(false); expect(result.toolReceipts[0].status).toBe("arguments_rejected");
});
test.each(["unknown-tool", "approval", "cross-thread", "cross-turn", "namespace", "duplicate-call", "conflict"])("%s poisons and closes the native session", async mode => {
  const f = await fixture(mode); const s = await create(f.options);
  await expect(s.runTurn(request())).rejects.toBeInstanceOf(AgentRuntimeError);
  const closed = await s.closed; expect(closed.ownedProcessClosed).toBe(true);
  expect(() => process.kill(s.identity.pid, 0)).toThrow();
});
test("late contradictory terminal notification closes a resident idle session", async () => {
  const f = await fixture("late-conflict"); const s = await create(f.options); await s.runTurn(request());
  const closed = await s.closed; expect(closed.reason).toBe("conflicting_turn_completion");
  expect(() => s.assertHealthy()).toThrow("conflicting_turn_completion");
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "conflicting_turn_completion" });
});
test.each(["mismatched-completed-tool", "mismatched-turn-tool"])("%s cannot relabel a host tool receipt", async mode => {
  const f = await fixture(mode); const executed: string[] = [];
  const query = tool(); query.execute = () => { executed.push("tcr_query"); return { dataClass: "metadata_only", value: {} }; };
  const other = { ...tool(), name: "tcr_other", execute() { executed.push("tcr_other"); return { dataClass: "metadata_only" as const, value: {} }; } };
  const s = await create({ ...f.options, tools: [query, other] });
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "native_tool_receipt_mismatch",
    toolReceipts: [{ callId: "call-1", tool: "tcr_query", status: "succeeded" }] });
  expect(executed).toEqual(["tcr_query"]);
  expect((await s.closed).reason).toBe("native_tool_receipt_mismatch");
});
test("health check exposes known poisoning before asynchronous closure finishes", async () => {
  const f = await fixture(); const t = tool();
  let identifyStarted!: () => void;
  const started = new Promise<void>(resolve => { identifyStarted = resolve; });
  t.execute = () => { identifyStarted(); return new Promise(() => {}); };
  const s = await create({ ...f.options, tools: [t], limits: { ...f.options.limits, toolShutdownMs: 100 } });
  const pending = s.runTurn(request()).then(() => ({ code: "unexpected_success" }), error => error);
  await started;
  let closed = false; void s.closed.then(() => { closed = true; });
  const closing = s.cancel();
  expect(() => s.assertHealthy()).toThrow("cancelled");
  await Promise.resolve(); expect(closed).toBe(false);
  expect((await closing).hostHandlersSettled).toBe(false); expect(await pending).toMatchObject({ code: "cancelled" });
});
test("owner-selected source output requires explicit session admission", async () => {
  const f = await fixture(); const t = tool(); t.execute = () => ({ dataClass: "owner_selected_source", value: "SYNTHETIC STAND-IN FOR OWNER BODY" });
  const s = await create({ ...f.options, tools: [t] });
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "agent_data_class_not_admitted" });
  expect(JSON.stringify(await f.messages())).not.toContain("SYNTHETIC STAND-IN");
  const other = await fixture(); const admitted = await create({ ...other.options, tools: [t], allowedDataClasses: ["synthetic", "owner_selected_source"], sourcePolicyId: "synthetic-policy" });
  expect((await admitted.runTurn(request())).toolReceipts[0].dataClass).toBe("owner_selected_source");
});
test("descriptor changes cannot expand a resident window's capabilities", async () => {
  const f = await fixture(); const s = await create(f.options);
  await expect(s.runTurn({ ...request(), tools: [{ ...tool(), description: "Different capability" }] })).rejects.toMatchObject({ code: "agent_tool_descriptor_changed" });
  expect((await f.messages()).some(x => x.method === "turn/start")).toBe(false);
});
test("host tool deadline aborts cooperatively and closes owned process", async () => {
  const f = await fixture(); let aborted = false; const t = tool();
  t.execute = (_args, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => { aborted = true; reject(Error("cancelled")); }, { once: true }));
  const s = await create({ ...f.options, tools: [t], limits: { ...f.options.limits, toolDeadlineMs: 20 } });
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "tool_deadline_exceeded", modelStartAttempted: true });
  expect(aborted).toBe(true); expect((await s.closed).hostHandlersSettled).toBe(true);
});
test("premature completion cannot accept while a host tool is pending", async () => {
  const f = await fixture("premature"); const t = tool();
  t.execute = (_args, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
  const s = await create({ ...f.options, tools: [t] });
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "turn_completed_with_pending_tools" });
});
test("cancelled and concurrent turns cannot outlive or overlap the session", async () => {
  const f = await fixture("wait"); const s = await create(f.options); const abort = new AbortController();
  const pending = s.runTurn({ ...request(), signal: abort.signal });
  await expect(s.runTurn(request())).rejects.toMatchObject({ code: "agent_turn_already_active" });
  setTimeout(() => abort.abort(), 30);
  await expect(pending).rejects.toMatchObject({ code: "cancelled", modelStartAttempted: true });
  expect((await s.closed).ownedProcessClosed).toBe(true);
});
test.each(["mcp-config", "no-auth", "no-model"])("%s fails before any native model turn", async mode => {
  const f = await fixture(mode); await expect(createAgentSession(f.options)).rejects.toMatchObject({ modelStartAttempted: false,
    closeReceipt: { ownedProcessClosed: true, turnsStarted: 0, native: { threadId: null } } });
  expect((await f.messages()).some(x => x.method === "turn/start")).toBe(false);
});
test("worker convenience respects explicit role and returns group cleanup", async () => {
  const f = await fixture("no-tool"); const result = await runAgentTurn({ ...f.options, ...request(), role: "semantic-worker" });
  expect(result.requested).toEqual({ model: "gpt-6-luna", effort: "medium" });
  expect(result.runtime.sessionOpen).toBe(false); expect(result.close.ownedProcessClosed).toBe(true);
});
test("closing a resident leader also removes ignored-stdio descendants", async () => {
  const f = await fixture("orphan"); const s = await create(f.options); await s.runTurn(request());
  const descendant = (await f.messages()).find(x => x.descendant).descendant;
  await s.close(); expect(() => process.kill(descendant, 0)).toThrow();
});
test.each([
  ["argument", "json_byte_limit"], ["result", "json_byte_limit"], ["total", "tool_total_byte_limit"],
] as const)("%s tool byte budget fails closed",async(kind,code)=>{
  const f=await fixture();const t=tool();t.execute=()=>({dataClass:"metadata_only",value:"x".repeat(100)});
  const narrowed=kind==="argument"?{maxToolArgumentBytes:1}:kind==="result"?{maxToolResultBytes:30}:{maxToolTotalBytes:15};
  const s=await create({...f.options,tools:[t],limits:{...f.options.limits,...narrowed}});
  await expect(s.runTurn(request())).rejects.toMatchObject({code,modelStartAttempted:true});
  expect((await s.closed).ownedProcessClosed).toBe(true);
});
test.each([["calls", "tool_call_limit_or_duplicate"],["concurrent", "tool_concurrency_limit"]] as const)("tool %s quota is enforced",async(kind,code)=>{
  const f=await fixture("burst");const t=tool();
  t.execute=(_args,ctx)=>new Promise((_,reject)=>ctx.signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true}));
  const s=await create({...f.options,tools:[t],limits:{...f.options.limits,...(kind==="calls"?{maxToolCalls:1}:{maxConcurrentTools:1})}});
  await expect(s.runTurn(request())).rejects.toMatchObject({code});
});
test("uncooperative host work is explicitly unconfirmed rather than silently declared closed",async()=>{
  const f=await fixture();const t=tool();t.execute=()=>new Promise(()=>{});
  const s=await create({...f.options,tools:[t],limits:{...f.options.limits,toolDeadlineMs:20,toolShutdownMs:30}});
  await expect(s.runTurn(request())).rejects.toMatchObject({code:"tool_deadline_exceeded",closeReceipt:{ownedProcessClosed:true,hostHandlersSettled:false}});
});
test("session turn budget closes the resident process without an extra model start",async()=>{
  const f=await fixture("no-tool");const s=await create({...f.options,limits:{...f.options.limits,maxTurns:1}});
  await s.runTurn(request());await expect(s.runTurn(request())).rejects.toMatchObject({code:"agent_turn_budget",modelStartAttempted:false});
  expect((await f.messages()).filter(x=>x.method==="turn/start")).toHaveLength(1);
  expect((await s.closed).ownedProcessClosed).toBe(true);
});
test("worker pre-turn validation failure retains observed startup identity and closure",async()=>{
  const f=await fixture();
  await expect(runAgentTurn({...f.options,...request(),input:{dataClass:"owner_selected_source",text:"not admitted"}}))
    .rejects.toMatchObject({code:"agent_data_class_not_admitted",modelStartAttempted:false,native:{threadId:"native-resident-thread"},closeReceipt:{ownedProcessClosed:true,turnsStarted:0}});
  expect((await f.messages()).some(x=>x.method==="turn/start")).toBe(false);
});

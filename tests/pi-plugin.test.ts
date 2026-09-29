import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "../src/store.ts";
import type { PiContext, PiEventMetadata, PiEventName, PiHookEnvelope } from "../integrations/pi/task-checkpoint-record.v1.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
type Launch = (command: string, args: string[], options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">) => ChildProcessWithoutNullStreams;
type BridgeOptions = { env?: Record<string, string | undefined>; launch?: Launch; onDrop?: (code: string) => void };
type Bridge = { enabled(): boolean; admit(value: PiHookEnvelope, signal: AbortSignal): Promise<void>; close(): Promise<void> };
type Handler = (event: PiEventMetadata, context: PiContext) => Promise<void>;
type Host = { on(name: PiEventName, handler: Handler): () => void };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function packageFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tcr-pi-"))); roots.push(root);
  const pkg = join(root, "package ' space $(touch SHOULD_NOT_EXIST)");
  cpSync(join(repo, "integrations/plugins/pi/task-checkpoint-record"), pkg, { recursive: true });
  const runtime = join(pkg, "runtime/recorder"); mkdirSync(runtime, { recursive: true });
  cpSync(join(repo, "src"), join(runtime, "src"), { recursive: true });
  for (const relative of ["package.json", "config/runtime.bunfig.toml", "container/app-server-surface.json", "integrations/pi/task-checkpoint-record.v1.ts"]) {
    mkdirSync(dirname(join(runtime, relative)), { recursive: true }); cpSync(join(repo, relative), join(runtime, relative));
  }
  const sourceRoot = join(root, "inputs"); mkdirSync(sourceRoot);
  const source = join(sourceRoot, "synthetic.jsonl");
  writeFileSync(source, '{"type":"session","version":3,"id":"pi-synthetic-session"}\n');
  const state = join(root, "state"), config = join(root, "config ' spaces.json");
  const body = JSON.stringify({ schema_version: "task-checkpoint.config.v1", recorder: { state_dir: state } });
  writeFileSync(config, body);
  const env = { PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? ""), TMPDIR: root,
    TCR_PLUGIN_ENABLED: "1", TCR_CONFIG: config, TCR_CONFIG_SHA256: sha(body), TCR_PROFILE: "pi-fixture" };
  const context: PiContext = { cwd: root, sessionManager: { getSessionId: () => "pi-synthetic-session", getSessionFile: () => source } };
  return { root, pkg, runtime, sourceRoot, source, state, config, env, context };
}

async function modules(pkg: string) {
  const bridge = await import(pathToFileURL(join(pkg, "extensions/bridge.ts")).href) as { createPiBridge(root: string, options?: BridgeOptions): Bridge };
  const entry = await import(pathToFileURL(join(pkg, "extensions/index.ts")).href) as { registerPiExtension(host: Host, options?: BridgeOptions): void };
  return { ...bridge, ...entry };
}

function host() {
  const handlers = new Map<PiEventName, Handler[]>();
  const api: Host = { on(name, handler) { const rows = handlers.get(name) ?? []; rows.push(handler); handlers.set(name, rows);
    return () => { const list = handlers.get(name); const at = list?.indexOf(handler) ?? -1; if (at >= 0) list!.splice(at, 1); }; } };
  return { api, handlers, async emit(name: PiEventName, event: PiEventMetadata, context: PiContext) {
    const results: unknown[] = []; for (const handler of [...(handlers.get(name) ?? [])]) results.push(await handler(event, context)); return results;
  } };
}

function bind(f: ReturnType<typeof packageFixture>) {
  const store = new Store(f.state, { initialize: true });
  store.bind({ schema_version: "task-checkpoint-record.binding.v1", binding_id: "pi-binding", task_id: "pi-task", project_id: null,
    client: "pi", profile: "pi-fixture", role: "master", runtime_home: null, native_session_id: "pi-synthetic-session", source_root: f.sourceRoot,
    sources: [{ source_id: "pi-source", path: f.source, format: "pi", start_at: "beginning" }] });
  return store;
}

test("factory and disabled/unconfigured/observer callbacks have no child or state effects", async () => {
  const f = packageFixture(), m = await modules(f.pkg);
  for (const env of [{}, { ...f.env, TCR_PLUGIN_ENABLED: "0" }, { ...f.env, TCR_CONFIG_SHA256: "invalid" },
    { ...f.env, TASK_CHECKPOINT_RECORD_ROLE: "observer" }, { ...f.env, TASK_CHECKPOINT_RECORD_WORKER: "1" }]) {
    const h = host(); let launched = 0;
    m.registerPiExtension(h.api, { env, launch: () => { launched++; throw new Error("unexpected spawn"); } });
    expect(launched).toBe(0);
    for (const name of ["session_start", "session_before_compact", "session_compact", "turn_end", "session_shutdown"] as const)
      expect((await h.emit(name, {}, f.context)).every(value => value === undefined)).toBe(true);
    expect(launched).toBe(0); expect(existsSync(f.state)).toBe(false);
    expect([...h.handlers.values()].flat().length).toBe(0);
  }
});

test("five real contained CLI callbacks enqueue source windows and preserve Pi control", async () => {
  const f = packageFixture(), m = await modules(f.pkg), h = host(), store = bind(f), drops: string[] = [], diagnostics: string[] = [];
  let children = 0;
  const launch: Launch = (command, args, settings) => {
    children++; expect(command).toBe("bun"); expect(settings.shell).toBe(false);
    expect(settings.env?.OPENROUTER_API_KEY).toBeUndefined(); expect(settings.env?.BUN_OPTIONS).toBeUndefined();
    expect(args).toContain(f.config); expect(args).toContain("pi");
    const child = spawn(command, args, settings); child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8"))); return child;
  };
  try {
    m.registerPiExtension(h.api, { env: { ...f.env, OPENROUTER_API_KEY: "synthetic-not-a-key", BUN_OPTIONS: "--preload=not-executed" }, launch, onDrop: code => drops.push(code) });
    expect(children).toBe(0);
    const event = { reason: "manual", outcome: "completed", messageEntryId: "entry-a", toolResultEntryIds: ["entry-b"],
      turnIndex: 73, continue: true, entries: [{ secret: "synthetic-body-not-forwarded" }], branchEntries: [{ text: "not-forwarded" }] };
    for (const name of ["session_start", "session_before_compact", "session_compact", "turn_end", "session_shutdown"] as const)
      expect((await h.emit(name, event, f.context)).every(value => value === undefined)).toBe(true);
    expect(diagnostics).toEqual([]); expect(drops).toEqual([]); expect(children).toBe(5);
    const rows = store.query({ kind: "events", filters: { task_id: "pi-task" }, fields: ["hook_event_name", "native_turn_id"] }).items as Record<string, unknown>[];
    expect(rows.length).toBe(5); expect(rows.every(row => row.native_turn_id === null)).toBe(true);
    expect((store.query({ kind: "windows", filters: { task_id: "pi-task" } }).items as unknown[]).length).toBe(5);
    expect((store.db.query("SELECT COUNT(*) AS n FROM services").get() as {n: number}).n).toBe(0);
    expect(existsSync(join(f.state, "codex-runtime"))).toBe(false); expect(existsSync(join(f.root, "SHOULD_NOT_EXIST"))).toBe(false);
    expect([...h.handlers.values()].flat().length).toBe(0);
  } finally { store.close(); }
});

test("config drift is a bounded drop and cannot open replacement state", async () => {
  const f = packageFixture(), m = await modules(f.pkg), h = host(), store = bind(f), drops: string[] = [];
  try {
    m.registerPiExtension(h.api, { env: f.env, onDrop: code => drops.push(code) });
    writeFileSync(f.config, JSON.stringify({ schema_version: "task-checkpoint.config.v1", recorder: { state_dir: join(f.root, "replacement") } }));
    await h.emit("session_start", {}, f.context); expect(drops).toEqual(["admission_failed"]);
    expect(existsSync(join(f.root, "replacement"))).toBe(false);
    expect((store.query({ kind: "events" }).items as unknown[]).length).toBe(0);
    await h.emit("session_shutdown", {}, f.context);
  } finally { store.close(); }
});

test("bridge rejects output/control data and reaps timeout and aborted children", async () => {
  const f = packageFixture(), m = await modules(f.pkg);
  const envelope: PiHookEnvelope = { schema_version: "task-checkpoint-record.pi-hook.v1", hook_event_name: "session_start",
    session_id: "pi-synthetic-session", cwd: f.root, transcript_path: f.source, adapter: { schema_version: "task-checkpoint-record.pi-adapter.v1",
      source_version: "0.87.1", reason: null, outcome: null, message_entry_id: null, tool_result_entry_ids: [], native_turn_id: null, persistence: "unverified_callback_metadata" } };
  for (const [name, code] of [["invalid", 'console.log(JSON.stringify({continue:true}))'], ["oversize", 'console.log("x".repeat(65536))'], ["timeout", 'setInterval(()=>{},1000)'], ["abort", 'setInterval(()=>{},1000)']] as const) {
    const script = join(f.root, name + ".js"); writeFileSync(script, code);
    let pid: number | undefined;
    const bridge = m.createPiBridge(f.pkg, { env: f.env, launch: (_command, _args, settings) => {
      const child = spawn(process.execPath, ["--no-env-file", "--no-install", "--config=" + join(f.runtime, "config/runtime.bunfig.toml"), script], settings);
      pid = child.pid; return child;
    } });
    const abort = new AbortController(); const running = bridge.admit(envelope, abort.signal);
    if (name === "abort") setTimeout(() => abort.abort(), 10);
    await expect(running).rejects.toThrow(); await bridge.close();
    let alive = false; if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* expected reaped child */ } }
    expect(alive).toBe(false);
  }
});

test("template omits raw bodies and does not invent a path for an in-memory session", async () => {
  const { registerTaskCheckpointRecord } = await import("../integrations/pi/task-checkpoint-record.v1.ts");
  const h = host(), values: PiHookEnvelope[] = [];
  const remove = registerTaskCheckpointRecord(h.api, { role: "master", admit: async value => { values.push(value); } });
  const f = packageFixture(); const context = { ...f.context, sessionManager: { getSessionId: () => "pi-memory", getSessionFile: () => undefined } };
  await h.emit("turn_end", { messageEntryId: "entry", toolResultEntryIds: ["one", 2], outcome: "aborted" }, context);
  expect(values[0]!.transcript_path).toBeNull(); expect(values[0]!.adapter.native_turn_id).toBeNull();
  expect(values[0]!.adapter.tool_result_entry_ids).toEqual(["one"]); remove();
});

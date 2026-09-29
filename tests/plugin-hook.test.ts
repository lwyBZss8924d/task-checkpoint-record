import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginHookMain, planPluginHook } from "../src/plugin-hook.ts";
import { Store } from "../src/store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
function temp() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tcr-plugin-"))); temps.push(dir); return dir; }
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const env = (config: string, sha: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  TCR_PLUGIN_ENABLED: "1", TCR_CONFIG: config, TCR_CONFIG_SHA256: sha, TCR_PROFILE: "fixture" });
function fixture(client: "codex" | "claude") {
  const root = temp(), state = join(root, "state"), sourceRoot = join(root, "inputs");
  mkdirSync(sourceRoot, { mode: 0o700 });
  const source = join(sourceRoot, "synthetic.jsonl"); writeFileSync(source, '{"type":"message","text":"synthetic-only"}\n');
  const store = new Store(state, { initialize: true });
  const binding = { schema_version: "task-checkpoint-record.binding.v1", binding_id: "plugin-fixture", task_id: "synthetic-task",
    project_id: "synthetic-project", client, profile: "fixture", role: "master", native_session_id: "synthetic-session", runtime_home: null,
    source_root: sourceRoot, sources: [{ source_id: "synthetic-source", path: source, format: client, start_at: "new" }] };
  const config = join(root, "task-checkpoint.json"), bytes = JSON.stringify({ schema_version: "task-checkpoint.config.v1", recorder: { state_dir: state } });
  writeFileSync(config, bytes, { mode: 0o600 });
  return { root, state, source, store, binding, config, env: env(config, digest(bytes)) };
}
async function call(root: string, client: "codex" | "claude", variables: Record<string, string | undefined>, payload: unknown, cwd = root) {
  const entry = join(root, "hook.ts");
  writeFileSync(entry, `import { pluginHookMain } from ${JSON.stringify(join(repo, "src/plugin-hook.ts"))}; await pluginHookMain(${JSON.stringify(client)});\n`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", entry], { cwd, env: variables, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(payload)); proc.stdin.end();
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out: JSON.parse(out), err };
}

describe("client plugin activation contract", () => {
  test("disabled, absent and observer environments perform no dispatch", async () => {
    for (const vars of [{}, { TCR_PLUGIN_ENABLED: "0" }, { TCR_PLUGIN_ENABLED: "1" },
      { ...env("/never-read.json", "a".repeat(64)), TASK_CHECKPOINT_RECORD_ROLE: "observer" },
      { ...env("/never-read.json", "a".repeat(64)), TASK_CHECKPOINT_RECORD_WORKER: "1" }]) {
      let calls = 0, output = "";
      await pluginHookMain("codex", { env: vars, dispatch: async () => { calls++; }, output: x => { output += x; } });
      expect(calls).toBe(0); expect(output).toBe("{}\n");
    }
  });
  test("explicit profile, digest and literal path are passed as separate arguments", () => {
    const path = join(temp(), "config $() ' spaces.json");
    expect(planPluginHook("claude", env(path, "a".repeat(64)))).toEqual({ disposition: "dispatch", argv:
      ["hook", "--config", path, "--config-sha256", "a".repeat(64), "--client", "claude", "--profile", "fixture"] });
    expect(planPluginHook("pi", env(path, "a".repeat(64)))).toEqual({ disposition: "dispatch", argv:
      ["hook", "--config", path, "--config-sha256", "a".repeat(64), "--client", "pi", "--profile", "fixture"] });
    for (const override of [{ TCR_CONFIG: "relative.json" }, { TCR_CONFIG_SHA256: "stale" },
      { TCR_PROFILE: "../profile" }, { TCR_PROFILE: "profile\ncommand" }]) {
      expect(planPluginHook("codex", { ...env(path, "a".repeat(64)), ...override }).argv).toBeNull();
    }
  });
  test("unconfigured plugin does not create state or consume a hostile dotenv", async () => {
    const root = temp(), state = join(root, "absent-state");
    writeFileSync(join(root, ".env"), `TCR_PLUGIN_ENABLED=1\nTCR_CONFIG=${join(root, "absent.json")}\nTASK_CHECKPOINT_RECORD_STATE=${state}\n`);
    const result = await call(root, "codex", { PATH: process.env.PATH, HOME: process.env.HOME }, { hook_event_name: "SessionStart" });
    expect(result).toEqual({ code: 0, out: {}, err: "" }); expect(existsSync(state)).toBe(false);
  });
  for (const client of ["codex", "claude"] as const) test(`${client} remains unbound, then enqueues only a bound master and stops after disable`, async () => {
    const f = fixture(client);
    const payload = { hook_event_name: "PreCompact", session_id: "synthetic-session", transcript_path: f.source, turn_id: "synthetic-turn" };
    try {
      expect((await call(f.root, client, f.env, payload)).out).toEqual({});
      expect((f.store.status().jobs as any[]).length).toBe(0);
      f.store.bind(f.binding);
      const before = (f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n;
      const result = await call(f.root, client, f.env, payload);
      expect(result).toEqual({ code: 0, out: {}, err: "" });
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(before + 1);
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM records").get() as any).n).toBe(0);
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM services").get() as any).n).toBe(0);
      for (const extra of [{ agent_id: "child" }, { stop_hook_active: true }, { task_checkpoint_record_observer: true }]) {
        expect((await call(f.root, client, f.env, { ...payload, ...extra })).out).toEqual({});
      }
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(before + 1);
      f.store.unbind(f.binding.binding_id);
      expect((await call(f.root, client, f.env, { ...payload, hook_event_name: "SessionEnd" })).out).toEqual({});
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(before + 1);
    } finally { f.store.close(); }
  });
  test("reviewed config drift returns legal empty output without opening replacement state", async () => {
    const f = fixture("codex"), replacement = join(f.root, "replacement-state");
    try {
      writeFileSync(f.config, JSON.stringify({ schema_version: "task-checkpoint.config.v1", recorder: { state_dir: replacement } }));
      const result = await call(f.root, "codex", f.env, { hook_event_name: "SessionStart", session_id: "synthetic-session" });
      expect(result.code).toBe(0); expect(result.out).toEqual({}); expect(result.err).toContain("config_digest_mismatch");
      expect(existsSync(replacement)).toBe(false);
    } finally { f.store.close(); }
  });
  for (const client of ["codex", "claude"] as const) test(`${client} copied plugin executes its native definition without a source checkout path`, async () => {
    const f = fixture(client), plugin = join(f.root, "plugin ' spaces $(touch NOT_CREATED)");
    try {
      cpSync(join(repo, "integrations/plugins", client, "task-checkpoint-record"), plugin, { recursive: true });
      mkdirSync(join(plugin, "runtime/recorder"), { recursive: true });
      cpSync(join(repo, "src"), join(plugin, "runtime/recorder/src"), { recursive: true });
      cpSync(join(repo, "package.json"), join(plugin, "runtime/recorder/package.json"));
      mkdirSync(join(plugin, "runtime/recorder/config"));
      cpSync(join(repo, "config/runtime.bunfig.toml"), join(plugin, "runtime/recorder/config/runtime.bunfig.toml"));
      // The actual client artifact includes this imported contract beside src/.
      mkdirSync(join(plugin, "runtime/recorder/container"));
      cpSync(join(repo, "container/app-server-surface.json"), join(plugin, "runtime/recorder/container/app-server-surface.json"));
      // Bun --no-env-file alone still honors cwd/global preload scripts. The
      // native definitions must select the shipped minimal config as well.
      const home = join(f.root, "synthetic-home"); mkdirSync(home);
      const preload = join(f.root, "preload.ts"), marker = join(f.root, "PRELOAD_EXECUTED");
      writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, "synthetic-only");\n`);
      const bunfig = `preload = [${JSON.stringify(preload)}]\n`;
      writeFileSync(join(f.root, "bunfig.toml"), bunfig); writeFileSync(join(home, ".bunfig.toml"), bunfig);
      f.store.bind(f.binding);
      const definition = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8")).hooks.SessionEnd[0].hooks[0];
      const cmd = client === "codex" ? ["/bin/sh", "-c", definition.command] :
        [definition.command, ...definition.args.map((arg: string) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin))];
      const proc = Bun.spawn(cmd, { cwd: f.root, env: { ...f.env, HOME: home, XDG_CONFIG_HOME: home,
        BUN_OPTIONS: "--preload=" + preload, NODE_OPTIONS: "--require=" + preload, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin },
        stdin: new Blob([JSON.stringify({ hook_event_name: "SessionEnd", session_id: "synthetic-session", transcript_path: f.source })]),
        stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, out, err }).toEqual({ code: 0, out: "{}\n", err: "" });
      expect((f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(1);
      expect(existsSync(join(f.state, "codex-runtime"))).toBe(false);
      expect(existsSync(join(f.root, "NOT_CREATED"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
      // Removing only the isolated installed fixture preserves user-owned state/config.
      rmSync(plugin, { recursive: true });
      expect(existsSync(f.config)).toBe(true); expect(existsSync(join(f.state, "store.sqlite"))).toBe(true);
    } finally { f.store.close(); }
  });
});

import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ensureLatestCodexRuntime, runRuntimeUpdateCommand, runtimeSelectionRevision } from "../src/runtime-update.ts";
import { fixtureQualifiedRuntime } from "./fixture-qualified-runtime.ts";

const directories: string[] = [];
function fixture(body: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tcr-updater-"))); directories.push(dir);
  const python = join(dir, "synthetic-python");
  writeFileSync(python, `#!${realpathSync(process.execPath)}\n${body}\n`); chmodSync(python, 0o700);
  return { dir, python, root: join(dir, "not-created") };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("updater subprocess gets isolated flags and preserves routing without credentials or native IDs", async () => {
  const f = fixture(`const keys=Object.keys(process.env);process.stdout.write(JSON.stringify({status:"inspected",selection:null,flags:process.argv.slice(2),keys,proxy:process.env.HTTPS_PROXY})+"\\n");`);
  const saved = { key: process.env.OPENROUTER_API_KEY, native: process.env.CODEX_THREAD_ID, python: process.env.PYTHONPATH, proxy: process.env.HTTPS_PROXY };
  try {
    process.env.OPENROUTER_API_KEY = "SYNTHETIC_CREDENTIAL_CANARY";
    process.env.CODEX_THREAD_ID = "synthetic-parent-native-id";
    process.env.PYTHONPATH = "/synthetic/preload";
    process.env.HTTPS_PROXY = "http://127.0.0.1:12345";
    const result = await runRuntimeUpdateCommand("status", { root: f.root, pythonExecutable: f.python });
    expect(result.flags.slice(0, 2)).toEqual(["-I", "-B"]);
    expect(result.keys).not.toContain("OPENROUTER_API_KEY"); expect(result.keys).not.toContain("CODEX_THREAD_ID"); expect(result.keys).not.toContain("PYTHONPATH");
    expect(result.proxy).toBe("http://127.0.0.1:12345"); expect(existsSync(f.root)).toBe(false);
  } finally {
    for (const [name, value] of [["OPENROUTER_API_KEY", saved.key], ["CODEX_THREAD_ID", saved.native], ["PYTHONPATH", saved.python], ["HTTPS_PROXY", saved.proxy]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test("aborting an updater closes its owned descendant group and reports no latest success", async () => {
  const f = fixture(`import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(process.argv[process.argv.indexOf("--root")+1]+".pids",JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const abort = new AbortController();
  const pending = ensureLatestCodexRuntime({ root: f.root, pythonExecutable: f.python, signal: abort.signal, deadlineMs: 5000 });
  for (let n = 0; n < 100 && !existsSync(f.root + ".pids"); n++) await Bun.sleep(10);
  expect(existsSync(f.root + ".pids")).toBe(true);
  const pids: number[] = JSON.parse(readFileSync(f.root + ".pids", "utf8")); abort.abort();
  const result = await pending;
  expect(result.status).toBe("update_failed"); expect(result.latestCheckSucceeded).toBe(false); expect(result.updateFailure?.code).toBe("runtime_update_aborted");
  for (const pid of pids) {
    let alive = true;
    for (let n = 0; n < 100 && alive; n++) { try { process.kill(pid, 0); await Bun.sleep(10); } catch (error: any) { expect(error.code).toBe("ESRCH"); alive = false; } }
    expect(alive).toBe(false);
  }
});

test("read-only revision lookup neither creates roots nor accepts ordinary account namespaces", () => {
  const f = fixture("process.exit(0)");
  expect(runtimeSelectionRevision(f.root)).toBe(null); expect(existsSync(f.root)).toBe(false);
  expect(() => runtimeSelectionRevision(join(f.dir, ".codex", "nested"))).toThrow("runtime_root_in_client_or_credential_namespace");
});

test("FIFO qualification and package files reject promptly before blocking reads", () => {
  const f = fixture("process.exit(0)"), qualified = fixtureQualifiedRuntime(f.python);
  const module = new URL("../src/runtime-update.ts", import.meta.url).pathname;
  const run = (input: { executable: string; qualificationPath: string }) => spawnSync(process.execPath,
    ["--no-env-file", "--no-install", `--config=${new URL("../config/runtime.bunfig.toml", import.meta.url).pathname}`, "-e",
      `import {validateRuntimeQualification} from ${JSON.stringify(module)};try{validateRuntimeQualification(${JSON.stringify(input)});process.exit(2)}catch(e){process.stdout.write(e.code);}`],
    { encoding: "utf8", timeout: 2000, env: { PATH: process.env.PATH }, maxBuffer: 65536 });
  const fifo = join(f.dir, "qualification-fifo");
  expect(spawnSync(Bun.which("mkfifo")!, [fifo]).status).toBe(0);
  const jsonCase = run({ executable: qualified.executable, qualificationPath: fifo });
  expect(jsonCase.error).toBeUndefined(); expect(jsonCase.status).toBe(0); expect(jsonCase.stdout).toBe("runtime_file_boundary");
  unlinkSync(qualified.executable); expect(spawnSync(Bun.which("mkfifo")!, [qualified.executable]).status).toBe(0);
  const packageCase = run(qualified);
  expect(packageCase.error).toBeUndefined(); expect(packageCase.status).toBe(0); expect(packageCase.stdout).toBe("runtime_package_file_boundary");
});

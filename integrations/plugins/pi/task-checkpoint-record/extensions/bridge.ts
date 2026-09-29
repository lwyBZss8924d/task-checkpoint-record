import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from "node:child_process";
import { join } from "node:path";
import { planPluginHook } from "../runtime/recorder/src/plugin-hook.ts";
import type { PiHookEnvelope } from "../runtime/recorder/integrations/pi/task-checkpoint-record.v1.ts";

type Environment = Record<string, string | undefined>;
type Launch = (command: string, args: string[], options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">) => ChildProcessWithoutNullStreams;
const EXECUTION_MS = 250;
const OUTPUT_BYTES = 32768;

/** No filesystem, child or timer effects until an enabled callback is admitted. */
export function createPiBridge(packageRoot: string, options: {
  env?: Environment; launch?: Launch; onDrop?: (code: string) => void;
} = {}) {
  const environment = options.env ?? process.env;
  const launch: Launch = options.launch ?? ((command, args, settings) => spawn(command, args, settings));
  const active = new Set<{ stop: () => void; closed: Promise<void> }>();
  let disposed = false;
  const enabled = () => !disposed && planPluginHook("pi", environment).disposition === "dispatch";
  const dropped = (code: string) => { try { options.onDrop?.(code); } catch { /* diagnostic only */ } };

  async function admit(envelope: PiHookEnvelope, signal: AbortSignal): Promise<void> {
    const plan = planPluginHook("pi", environment);
    if (disposed || plan.argv === null || signal.aborted) return;
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > 65536) throw new Error("pi_hook_input_budget");
    const childEnv: NodeJS.ProcessEnv = { TASK_CHECKPOINT_RECORD_ROLE: "master" };
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
      if (environment[key] !== undefined) childEnv[key] = environment[key];
    }
    const command = ["--no-env-file", "--no-install", "--config=" + join(packageRoot, "runtime/recorder/config/runtime.bunfig.toml"),
      join(packageRoot, "runtime/recorder/src/cli.ts"), ...plan.argv];
    const child = launch("bun", command, { cwd: packageRoot, env: childEnv, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure: string | null = null;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    let settle!: () => void;
    let reject!: (reason: Error) => void;
    const result = new Promise<void>((resolve, fail) => { settle = resolve; reject = fail; });
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const group = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "pi_hook_cleanup_unverified"; }
    };
    const fail = (code: string) => {
      failure ??= code;
      if (finished || killTimer) return;
      group("SIGTERM");
      killTimer = setTimeout(() => group("SIGKILL"), 50);
      abandonTimer = setTimeout(() => {
        if (!finished) reject(new Error("pi_hook_cleanup_unverified"));
      }, 150);
    };
    const item = { stop: () => fail("pi_hook_disposed"), closed };
    active.add(item);
    const timer = setTimeout(() => fail("pi_hook_deadline"), EXECUTION_MS);
    const aborted = () => fail("pi_hook_aborted");
    signal.addEventListener("abort", aborted, { once: true });
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > OUTPUT_BYTES) { fail("pi_hook_output_budget"); return; }
      if (kind === "stdout") stdout = Buffer.concat([stdout, chunk]); else stderr = Buffer.concat([stderr, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", () => fail("pi_hook_spawn_failed"));
    child.stdin.on("error", () => fail("pi_hook_stdin_failed"));
    child.once("close", code => {
      finished = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(abandonTimer);
      signal.removeEventListener("abort", aborted);
      group("SIGKILL"); // A successful fixed-purpose CLI must not leave owned descendants.
      active.delete(item); release();
      if (!failure && (code !== 0 || stderr.length > 0)) failure = "pi_hook_cli_failed";
      if (!failure) {
        try { const value: unknown = JSON.parse(stdout.toString("utf8")); if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length) failure = "pi_hook_output_invalid"; }
        catch { failure = "pi_hook_output_invalid"; }
      }
      if (failure) reject(new Error(failure)); else settle();
    });
    if (signal.aborted) aborted();
    child.stdin.end(body + "\n");
    await result;
  }

  async function close(): Promise<void> {
    if (disposed && active.size === 0) return;
    disposed = true;
    const pending = [...active]; for (const item of pending) item.stop();
    if (!pending.length) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending.map(item => item.closed)), new Promise<void>(resolve => { deadline = setTimeout(() => { dropped("pi_hook_cleanup_unverified"); resolve(); }, 200); })]);
    clearTimeout(deadline);
  }
  return { enabled, admit, close, dropped };
}

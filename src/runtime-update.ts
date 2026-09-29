/** Host-owned official runtime selection. No credentials or model calls. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import protocolContract from "../container/app-server-surface.json";

export class RuntimeUpdateError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new RuntimeUpdateError(code); };
export type QualifiedCodexRuntime = Readonly<{ version: string; executableSha256: string; qualificationSha256: string }>;
export type RuntimeSelection = { executable: string; version: string; qualificationPath: string };
export type RuntimeUpdateResult = { status: "current" | "updated" | "deferred_busy" | "update_failed" | "held_not_latest"; selection: RuntimeSelection | null;
  checkedAt: string | null; latestCheckSucceeded: boolean; updateFailure: { code: string } | null };
export type RuntimeUpdateOptions = { root: string; currentExecutable?: string | null; busy?: boolean; checkIntervalMs?: number;
  force?: boolean; signal?: AbortSignal; pythonExecutable?: string; deadlineMs?: number; rollbackVersion?: string; resumeLatest?: boolean };

function canonical(x: any): string { return x === null || typeof x !== "object" ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`; }
function safe(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) fail("runtime_path_not_absolute_canonical");
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail("runtime_symlink_denied"); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
}
function safeRoot(root: string): void {
  safe(root);
  if (root.split("/").some(x => [".codex", ".codex-test", ".claude", ".pi", "auth.json", ".env"].includes(x))) fail("runtime_root_in_client_or_credential_namespace");
}
function bytes(path: string, cap = 2 * 1024 * 1024): Buffer {
  safe(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > cap) fail("runtime_file_boundary");
    const data = readFileSync(fd); const end = fstatSync(fd); if (data.length !== st.size || st.size !== end.size || st.mtimeMs !== end.mtimeMs) fail("runtime_file_changed"); return data;
  } finally { closeSync(fd); }
}
function hashFile(path: string): string {
  safe(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > 1024 * 1024 * 1024) fail("runtime_package_file_boundary");
    const hash = createHash("sha256"), buf = Buffer.alloc(1024 * 1024); let n = 0;
    while (n < st.size) { const read = readSync(fd, buf, 0, Math.min(buf.length, st.size - n), n); if (!read) fail("runtime_file_changed"); hash.update(buf.subarray(0, read)); n += read; }
    const after = fstatSync(fd); if (st.size !== after.size || st.mtimeMs !== after.mtimeMs) fail("runtime_file_changed"); return hash.digest("hex");
  } finally { closeSync(fd); }
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function json(path: string): any { try { return JSON.parse(bytes(path).toString("utf8")); } catch (e) { if (e instanceof RuntimeUpdateError) throw e; return fail("runtime_json_invalid"); } }
function inventory(root: string): { path: string; size: number; mode: number; sha256: string }[] {
  const result: { path: string; size: number; mode: number; sha256: string }[] = []; let total = 0;
  const walk = (dir: string) => { for (const entry of readdirSync(dir).sort()) { const path = join(dir, entry), info = lstatSync(path);
    if (info.isSymbolicLink()) fail("runtime_symlink_denied");
    if (info.isDirectory()) walk(path);
    else { total += info.size; if (result.length >= 2048 || total > 1024 * 1024 * 1024) fail("runtime_package_budget");
      result.push({ path: relative(root, path), size: info.size, mode: info.mode & 0o777, sha256: hashFile(path) }); }
  }}; walk(root); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function supportRoot(): string {
  // Source src/, installed record/ and full-client compiled root layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(here, ".."), here]) {
    try { const path = join(root, "scripts/runtime/update.py"); safe(path); if (lstatSync(path).isFile()) return root; } catch { /* Try only the other package-relative layout. */ }
  }
  return fail("runtime_support_files_missing");
}

/** Receipts are local host attestations, not publisher signatures. Replay their
 * exact package inventory and reviewed protocol observations before accepting. */
export function validateRuntimeQualification(input: { executable: string; qualificationPath: string; observedVersion?: string }): QualifiedCodexRuntime {
  try {
    safe(input.executable); safe(input.qualificationPath);
    const raw = bytes(input.qualificationPath), receipt = JSON.parse(raw.toString("utf8"));
    const dir = dirname(input.qualificationPath), packageRoot = join(dir, "package");
    if (input.executable !== join(packageRoot, "bin/codex") || dirname(dir).split("/").at(-1) !== "versions") fail("runtime_qualification_path_mismatch");
    const owner = json(join(dirname(dirname(dir)), "owner.json"));
    if (canonical(owner) !== canonical({ schema_version: "task-checkpoint.codex-runtime-owner.v1", owner: "task-checkpoint-record" })) fail("runtime_owner_mismatch");
    const version = receipt.version;
    if (receipt.schema_version !== "task-checkpoint.codex-qualification.v1" || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || receipt.observed_version !== `codex-cli ${version}` || receipt.package !== "package" || receipt.entrypoint !== "bin/codex" || receipt.authenticated_model_run !== false) fail("runtime_qualification_identity");
    if (input.observedVersion !== undefined && input.observedVersion !== version) fail("runtime_version_identity_mismatch");
    const initialized = receipt.initialize;
    if (initialized?.method !== "initialize" || initialized.observed_version !== version || initialized.initialized_notification_sent !== true || initialized.threads_started !== 0 || initialized.turns_started !== 0 || initialized.process_exit_code !== 0) fail("runtime_initialize_evidence_missing");
    const release = receipt.release, platform = receipt.platform, asset = release?.codex_assets?.[platform];
    const targets: Record<string, string> = { amd64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin" };
    if (!targets[platform] || release?.codex_version !== version || release.codex_release !== `https://github.com/openai/codex/releases/tag/rust-v${version}` || release.discovery?.url !== "https://api.github.com/repos/openai/codex/releases/latest" || release.discovery?.draft !== false || release.discovery?.prerelease !== false || asset?.target !== targets[platform] || asset.name !== `codex-package-${targets[platform]}.tar.gz` || !/^[a-f0-9]{64}$/.test(asset.sha256) || receipt.archive_sha256 !== asset.sha256) fail("runtime_official_release_binding");
    if (dir.split("/").at(-1) !== `${version}-${asset.sha256}`) fail("runtime_version_namespace_mismatch");
    if (!Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 2048 || canonical(inventory(packageRoot)) !== canonical(receipt.files)) fail("runtime_package_changed");
    const metadata = json(join(packageRoot, "codex-package.json"));
    if (metadata.layoutVersion !== 1 || metadata.version !== version || metadata.target !== targets[platform] || metadata.variant !== "codex" || metadata.entrypoint !== "bin/codex" || metadata.resourcesDir !== "codex-resources" || metadata.pathDir !== "codex-path") fail("runtime_package_identity");
    for (const name of ["bin/codex", "bin/codex-code-mode-host"]) if (!(lstatSync(join(packageRoot, name)).mode & 0o111)) fail("runtime_paired_executables_missing");
    for (const name of ["codex-resources", "codex-path"]) if (!lstatSync(join(packageRoot, name)).isDirectory()) fail("runtime_resources_missing");
    const contractBytes = bytes(join(supportRoot(), "container/app-server-surface.json"));
    if (canonical(JSON.parse(contractBytes.toString("utf8"))) !== canonical(protocolContract)) fail("runtime_support_contract_mismatch");
    const observation = receipt.protocol;
    const expected = protocolContract.schemas.map(s => ({ file: s.file, type: "object", required: s.required,
      checks: s.checks.map(c => ({ pointer: c.pointer, observed: c.equals })) }));
    if (observation?.contract_sha256 !== hash(contractBytes) || observation.version !== version || observation.result !== "protocol_surface_pass" || observation.authenticated_model_run !== false || observation.schemas !== expected.length || observation.structural_checks !== expected.reduce((n, s) => n + s.checks.length, 0) || canonical(observation.observations) !== canonical(expected)) fail("runtime_protocol_observations_changed");
    return Object.freeze({ version, executableSha256: hashFile(input.executable), qualificationSha256: hash(raw) });
  } catch (e) { if (e instanceof RuntimeUpdateError) throw e; return fail("runtime_qualification_invalid"); }
}

function selected(root: string): RuntimeSelection | null {
  try {
    const pointer = json(join(root, "current.json")), value = pointer.selection;
    if (pointer.schema_version !== "task-checkpoint.codex-selection.v1" || typeof value?.qualificationPath !== "string" || dirname(dirname(value.qualificationPath)) !== join(root, "versions")) fail("runtime_selection_invalid");
    validateRuntimeQualification(value); return value;
  } catch (e: any) { if (!lstatExists(join(root, "current.json"))) return null; throw e; }
}
function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } }

/** Cheap local change signal for idle lifecycle rotation; never downloads or
 * hashes the package. Qualification still occurs before the selection is used. */
export function runtimeSelectionRevision(root: string): string | null {
  safeRoot(root);
  const owner = join(root, "owner.json");
  if (!lstatExists(owner)) return null;
  if (canonical(json(owner)) !== canonical({ schema_version: "task-checkpoint.codex-runtime-owner.v1", owner: "task-checkpoint-record" })) fail("runtime_owner_mismatch");
  const observations = ["current.json", "hold.json"].map(name => { const path = join(root, name); return lstatExists(path) ? hash(bytes(path, 16 * 1024)) : null; });
  return hash(canonical(observations));
}

export async function runRuntimeUpdateCommand(action: "status" | "plan" | "ensure" | "rollback", options: RuntimeUpdateOptions): Promise<any> {
  safeRoot(options.root); if (process.platform === "win32") fail("runtime_platform_unsupported");
  if (options.signal?.aborted) fail("runtime_update_aborted");
  const root = supportRoot(), pythonPin = join(root, "config/runtime-python.json");
  const pinned = lstatExists(pythonPin) ? json(pythonPin) : null;
  const python = options.pythonExecutable ?? pinned?.path ?? realpathSync(Bun.which("python3") ?? fail("python_3_9_required")); safe(python);
  if (pinned && (python !== pinned.path || hashFile(python) !== pinned.sha256)) fail("runtime_python_changed");
  const interval = options.checkIntervalMs ?? 14400000;
  if (!Number.isSafeInteger(interval) || interval < 60000 || interval > 86400000) fail("runtime_interval_out_of_range");
  if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 300000)) fail("runtime_deadline_out_of_range");
  if (options.rollbackVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(options.rollbackVersion)) fail("runtime_rollback_version_invalid");
  if (action === "rollback" && options.busy) fail("runtime_rollback_busy");
  const args = ["-I", "-B", join(root, "scripts/runtime/update.py"), action, "--root", options.root, "--interval-ms", String(interval), ...(options.busy ? ["--busy"] : []), ...(options.force ? ["--force"] : []), ...(options.resumeLatest ? ["--resume-latest"] : []), ...(options.rollbackVersion ? ["--version", options.rollbackVersion] : [])];
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const report = await new Promise<any>((resolvePromise, rejectPromise) => {
    const child = spawn(python, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0, reason: string | null = null, timer: ReturnType<typeof setTimeout>;
    const closeGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") reason ??= "runtime_update_group_close_failed"; } } };
    const abort = () => { reason = "runtime_update_aborted"; closeGroup(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { reason = "runtime_update_deadline"; closeGroup(); }, options.deadlineMs ?? 240000);
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size > 2 * 1024 * 1024) { reason = "runtime_update_output_budget"; closeGroup(); } else chunks.push(b); });
    child.stderr.on("data", (b: Buffer) => { size += b.length; if (size > 2 * 1024 * 1024) { reason = "runtime_update_output_budget"; closeGroup(); } });
    child.once("error", () => { reason = "runtime_update_process_start_failed"; });
    child.once("close", code => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); closeGroup();
      if (reason) { rejectPromise(new RuntimeUpdateError(reason)); return; }
      try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (code && value.status !== "update_failed") fail("runtime_update_process_failed"); resolvePromise(value); }
      catch (error) { rejectPromise(error instanceof RuntimeUpdateError ? error : new RuntimeUpdateError("runtime_update_response_invalid")); }
    });
    if (options.signal?.aborted) abort();
  });
  if (report.selection) { validateRuntimeQualification(report.selection); if (dirname(dirname(report.selection.qualificationPath)) !== join(options.root, "versions")) fail("runtime_selection_outside_owner_root"); }
  return report;
}

export async function ensureLatestCodexRuntime(options: RuntimeUpdateOptions): Promise<RuntimeUpdateResult> {
  try { return await runRuntimeUpdateCommand("ensure", options) as RuntimeUpdateResult; }
  catch (e) { let selection: RuntimeSelection | null = null; try { selection = selected(options.root); } catch { /* No invalid fallback. */ }
    return { status: "update_failed", selection, checkedAt: new Date().toISOString(), latestCheckSucceeded: false,
      updateFailure: { code: e instanceof RuntimeUpdateError ? e.code : "runtime_update_failed" } };
  }
}

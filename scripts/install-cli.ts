/** Source-owned installation; no effects on import and no package-manager calls. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const OWNER = "task-checkpoint-record.cli.v1";
export const BUN_CONFIG_RELATIVE = "config/runtime.bunfig.toml";
const COMMANDS = ["task-checkpoint-record", "ultrafast-atif-helper"] as const;
const CAP = 8 * 1024 * 1024;
export class InstallError extends Error { constructor(readonly code: string) { super(code); } }
export function fail(code: string): never { throw new InstallError(code); }
export function canonical(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  return Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
}
export const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
export function string(x: unknown): string {
  if (typeof x !== "string" || !x.length || x.length > 8192 || /[\x00-\x1f\x7f]/.test(x)) fail("invalid_string");
  return x;
}
export function absolute(x: unknown): string {
  const p = string(x); if (!isAbsolute(p) || resolve(p) !== p) fail("noncanonical_path");
  if (p.split(sep).some(s => /^(auth|credentials|secrets|tokens?)(\.|$)|^\.env($|\.)|\.(pem|key|p12|pfx)$/i.test(s))) fail("credential_path_denied");
  return p;
}
function stat(p: string) { try { return lstatSync(p); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } }
export function safePath(p: string, missingLeaf = false): void {
  absolute(p); let current: string = sep;
  for (const component of p.split(sep).filter(Boolean)) {
    current = join(current, component); const s = stat(current);
    if (!s) { if (missingLeaf && current === p) return; fail("path_missing"); }
    if (s.isSymbolicLink()) fail("symlink_denied");
    if (current !== p && !s.isDirectory()) fail("not_directory");
  }
}
export function ownedDirectory(p: string): void {
  safePath(p); const s = lstatSync(p);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o022)) fail("directory_not_owned_or_writable_by_others");
}
export function readSafe(p: string, cap = CAP): Buffer {
  safePath(p); const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > cap) fail("nonregular_aliased_or_large_file");
    const bytes = Buffer.alloc(s.size); let n = 0;
    while (n < bytes.length) { const r = readSync(fd, bytes, n, bytes.length - n, n); if (!r) fail("file_changed"); n += r; }
    const after = fstatSync(fd); if (after.size !== s.size || after.mtimeMs !== s.mtimeMs) fail("file_changed");
    return bytes;
  } finally { closeSync(fd); }
}
export function fileHash(p: string): string {
  safePath(p); return hashRegularFile(p);
}
/** Callers must validate the full path first; descriptor checks still reject aliases. */
function hashRegularFile(p: string): string {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 512 * 1024 * 1024) fail("unsafe_hash_input");
    const h = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < s.size) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, s.size - offset), offset); if (!n) fail("file_changed"); h.update(buffer.subarray(0, n)); offset += n; }
    const after = fstatSync(fd); if (s.size !== after.size || s.mtimeMs !== after.mtimeMs) fail("file_changed");
    return h.digest("hex");
  } finally { closeSync(fd); }
}
export function writeNew(p: string, value: string | Buffer, mode = 0o600): void {
  safePath(p, true); ownedDirectory(dirname(p)); const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
type ReceiptRecovery = { receipt: string; journal: string; phase: "effect_failed" | "receipt_publication_failed"; prepared_sha256: string; result_journaled: boolean };
export class ReceiptOperationError extends InstallError {
  constructor(code: string, readonly recovery: ReceiptRecovery, readonly effect_result?: unknown) { super(code); }
}
/** Reserve two private files before effects. The append-only recovery journal
 * retains the reviewed input before execution and the full result before the
 * final receipt is published. A pending file is explicitly not a receipt. */
export function withReceipt<T>(outputPath: string, input: { operation: string; path: string; sha256: string; value: unknown }, effect: () => T, protectedPaths: string[] = []): T {
  const output = absolute(outputPath), parent = dirname(output);
  for (const path of protectedPaths) {
    const rel = relative(absolute(path), output);
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))) fail("receipt_overlaps_effect_target");
  }
  safePath(output, true); ownedDirectory(parent);
  if (stat(output)) fail("receipt_exists");
  const parentIdentity = lstatSync(parent);
  const journal = join(parent, `.${output.split(sep).at(-1)}.recovery-${randomUUID()}.jsonl`);
  const prepared = JSON.stringify({ schema_version: "task-checkpoint-record.receipt-recovery.v1", owner: OWNER, phase: "prepared_not_completion", receipt: output,
    input: { operation: string(input.operation), path: absolute(input.path), sha256: input.sha256, value: input.value } }) + "\n";
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || Buffer.byteLength(prepared) > CAP) fail("invalid_recovery_input");
  const preparedHash = sha(prepared);
  let receiptFd: number | undefined, journalFd: number | undefined, effectsStarted = false;
  const descriptors: { path: string; fd: number; dev: number; ino: number }[] = [];
  const reserve = (path: string, append: boolean): number => {
    safePath(path, true); ownedDirectory(parent);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0), 0o600);
    const st = fstatSync(fd); descriptors.push({ path, fd, dev: st.dev, ino: st.ino }); fchmodSync(fd, 0o600); return fd;
  };
  const sameFile = (entry: typeof descriptors[number]): void => {
    safePath(entry.path); const st = lstatSync(entry.path), opened = fstatSync(entry.fd);
    if (!st.isFile() || st.dev !== entry.dev || st.ino !== entry.ino || st.nlink !== 1 || opened.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) fail("receipt_reservation_changed");
  };
  const appendJournal = (line: string): void => {
    if (Buffer.byteLength(line) > CAP) fail("receipt_result_too_large");
    sameFile(descriptors.find(d => d.fd === journalFd)!); writeFileSync(journalFd!, line); fsyncSync(journalFd!);
  };
  const publish = (body: string): void => {
    if (Buffer.byteLength(body) > CAP) fail("receipt_result_too_large");
    ownedDirectory(parent); const now = lstatSync(parent);
    if (now.dev !== parentIdentity.dev || now.ino !== parentIdentity.ino) fail("receipt_parent_changed");
    sameFile(descriptors.find(d => d.fd === receiptFd)!);
    const bytes = Buffer.from(body); let n = 0;
    while (n < bytes.length) { const count = writeSync(receiptFd!, bytes, n, bytes.length - n, n); if (!count) fail("receipt_write_incomplete"); n += count; }
    ftruncateSync(receiptFd!, bytes.length); fsyncSync(receiptFd!);
    sameFile(descriptors.find(d => d.fd === receiptFd)!);
    if (fileHash(output) !== sha(bytes)) fail("receipt_write_verification_failed");
  };
  try {
    receiptFd = reserve(output, false); journalFd = reserve(journal, true);
    appendJournal(prepared);
    publish(JSON.stringify({ schema_version: "task-checkpoint-record.receipt-pending.v1", owner: OWNER, phase: "prepared_not_completion", recovery_journal: journal, prepared_sha256: preparedHash }) + "\n");
    // Make both names durable before the first target mutation.
    const dirFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    effectsStarted = true;
    let result: T;
    try { result = effect(); }
    catch (error) {
      const code = error instanceof InstallError ? error.code : "operation_failed";
      try { appendJournal(JSON.stringify({ phase: "effect_failed", error: code, requires_target_verification: true }) + "\n"); } catch { /* Prepared input remains the recovery baseline. */ }
      throw new ReceiptOperationError(code, { receipt: output, journal, phase: "effect_failed", prepared_sha256: preparedHash, result_journaled: false });
    }
    let resultJournaled = false;
    try {
      appendJournal(JSON.stringify({ phase: "effects_completed", result }) + "\n"); resultJournaled = true;
      publish(JSON.stringify(result, null, 2) + "\n");
    } catch {
      // Preserve the actual result on the structured output channel as well as
      // any durable journal, even if final publication is no longer possible.
      throw new ReceiptOperationError("receipt_publication_failed", { receipt: output, journal, phase: "receipt_publication_failed", prepared_sha256: preparedHash, result_journaled: resultJournaled }, result);
    }
    return result;
  } finally {
    if (!effectsStarted) {
      // Remove only our still-identical reservations; never overwrite or unlink
      // a replacement introduced by another writer.
      for (const entry of descriptors) try { sameFile(entry); unlinkSync(entry.path); } catch { /* A changed reservation needs owner inspection. */ }
    }
    for (const entry of descriptors) try { closeSync(entry.fd); } catch { /* Already closed by the runtime. */ }
  }
}
export function json(p: string): any { try { return JSON.parse(readSafe(p).toString("utf8")); } catch (e) { if (e instanceof InstallError) throw e; fail("invalid_json"); } }
export function shellQuote(s: string): string { string(s); return `'${s.replaceAll("'", `'"'"'`)}'`; }
export function checkedJSON(p: string, expected: string): any {
  if (!/^[a-f0-9]{64}$/.test(expected)) fail("invalid_digest"); const bytes = readSafe(p); if (sha(bytes) !== expected) fail("reviewed_plan_changed");
  try { return JSON.parse(bytes.toString()); } catch { fail("invalid_json"); }
}
type FileEntry = { path: string; sha256: string; mode: number };
type Runtime = { path: string; sha256: string; version: string };
export type Manifest = {
  schema_version: "task-checkpoint-record.install-manifest.v1"; owner: string;
  sources: { name: string; root: string; version: string; files: FileEntry[] }[];
  runtimes: { bun: Runtime; node: Runtime }; files: FileEntry[];
  /** Absent only on legacy manifests retained for inspection and rollback. */
  bun_config_path?: typeof BUN_CONFIG_RELATIVE;
  help_checks: { name: string; stdout_sha256: string; exit_code: 0 }[];
  distribution?: { manifest_sha256: string; release: ReleaseBundle; installed_licenses: { recorder: string; helper: string } };
};
type ReleaseFile = FileEntry & { size: number };
type ReleaseComponent = { name: string; version: string; root: string; source: { repository: string; commit: string };
  license: { spdx: "MIT"; path: string; sha256: string }; files: ReleaseFile[] };
export type ReleaseBundle = { schema_version: "task-checkpoint-record.release-bundle.v1";
  recorder: ReleaseComponent; helper: ReleaseComponent;
  compatibility: { helper_page_schema: "ultrafast-atif.page.v1"; recorder_help_schema: "task-checkpoint-record.help.v1" } };
type Snapshot = { exists: boolean; sha256: string | null; bytes: string | null; mode: number | null };
export type InstallPlan = {
  schema_version: "task-checkpoint-record.install-plan.v1"; owner: string; plan_only: true;
  stage: string; prefix: string; version_id: string; manifest: Manifest;
  before: { current: Snapshot; commands: Record<string, Snapshot> };
};
function fileList(root: string, dir = ""): FileEntry[] {
  const result: FileEntry[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name, path = join(root, rel); safePath(path); const s = lstatSync(path);
    if (s.isDirectory()) result.push(...fileList(root, rel));
    else if (s.isFile() && s.nlink === 1) result.push({ path: rel, sha256: fileHash(path), mode: s.mode & 0o777 });
    else fail("unsafe_artifact");
  }
  if (result.length > 4096) fail("artifact_count_exceeded"); return result;
}
function relativeFile(path: unknown): string {
  const p = string(path);
  if (isAbsolute(p) || p.includes("\\") || p.split("/").some(s => !s || s === "." || s === "..")) fail("invalid_bundle_path");
  // Public bundles have neither repository internals nor runtime/private payloads.
  if (p.split("/").some(s => [".git", "node_modules", "workspace", "state", "sessions", "memories"].includes(s))) fail("private_or_dependency_bundle_path");
  return p;
}
export function verifyReleaseBundle(root: string, expectedManifestSha: string): ReleaseBundle {
  ownedDirectory(root); const manifestPath = join(root, "release-bundle.json");
  const release = checkedJSON(manifestPath, expectedManifestSha) as ReleaseBundle;
  if (release?.schema_version !== "task-checkpoint-record.release-bundle.v1" || release.compatibility?.helper_page_schema !== "ultrafast-atif.page.v1" || release.compatibility?.recorder_help_schema !== "task-checkpoint-record.help.v1") fail("unsupported_release_bundle");
  const expected = new Map<string, ReleaseFile>(); let bytes = 0;
  for (const [key, name, subroot] of [["recorder", "task-checkpoint-record", "."], ["helper", "ultrafast-atif-helper", "vendor/ultrafast-atif-helper"]] as const) {
    const component = release[key];
    if (component?.name !== name || component.root !== subroot || component.source?.repository !== `https://github.com/lwyBZss8924d/${name}` || !/^[a-f0-9]{40}$/.test(component.source?.commit ?? "")) fail("invalid_release_component");
    string(component.version);
    if (!Array.isArray(component.files) || !component.files.length || component.files.length > 4096) fail("invalid_release_inventory");
    for (const f of component.files) {
      const path = relativeFile(f.path);
      if (path === "release-bundle.json" || expected.has(path) || (key === "helper" ? !path.startsWith(subroot + "/") : path.startsWith("vendor/"))) fail("overlapping_release_inventory");
      if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0 || ![0o644, 0o755].includes(f.mode)) fail("invalid_release_file");
      bytes += f.size; if (bytes > 64 * 1024 * 1024) fail("release_bundle_too_large"); expected.set(path, f);
    }
    const licensePath = key === "recorder" ? "LICENSE" : `${subroot}/LICENSE`;
    if (component.license?.spdx !== "MIT" || component.license.path !== licensePath || expected.get(licensePath)?.sha256 !== component.license.sha256) fail("invalid_release_license");
  }
  // Enumerate names before reading contents, so unexpected private files are
  // rejected without hashing or copying their contents into an installation.
  const releasePath = (rel: string): string => {
    const path = join(root, rel);
    // This public command document is admitted only in the exact recorder
    // inventory reviewed above. Generic paths and credential guards stay strict.
    if (rel === "integrations/plugins/claude/task-checkpoint-record/commands/auth.md" && expected.has(rel)) {
      safePath(dirname(path)); const s = lstatSync(path);
      if (s.isSymbolicLink()) fail("symlink_denied");
      if (!s.isFile() || s.nlink !== 1) fail("unsafe_release_file");
    } else safePath(path);
    return path;
  };
  const seen = new Set<string>(); let directories = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 32 || ++directories > 4096) fail("bundle_directory_budget");
    for (const name of readdirSync(join(root, dir))) {
      const rel = dir ? `${dir}/${name}` : name; relativeFile(rel); const path = releasePath(rel), s = lstatSync(path);
      if (s.isDirectory()) walk(rel, depth + 1);
      else { if (!s.isFile() || s.nlink !== 1) fail("unsafe_release_file"); if (rel !== "release-bundle.json" && !expected.has(rel)) fail("unexpected_release_file"); seen.add(rel); }
    }
  };
  walk("", 0);
  if (seen.size !== expected.size + 1) fail("release_file_missing");
  for (const [path, f] of expected) { const full = releasePath(path), s = lstatSync(full); if (s.size !== f.size || (s.mode & 0o777) !== f.mode || hashRegularFile(full) !== f.sha256) fail("release_file_changed"); }
  for (const component of [release.recorder, release.helper]) {
    const pkgPath = component.root === "." ? "package.json" : `${component.root}/package.json`;
    if (!expected.has(pkgPath)) fail("release_package_missing"); const pkg = json(join(root, pkgPath));
    if (pkg.name !== component.name || pkg.version !== component.version) fail("release_package_mismatch");
    const license = readSafe(join(root, component.license.path)).toString();
    if (!license.includes("MIT License") || !license.includes("Permission is hereby granted")) fail("release_license_content_mismatch");
  }
  return release;
}
function source(root: string, name: string) {
  ownedDirectory(root); const pkg = json(join(root, "package.json")); if (pkg.name !== name) fail("source_package_mismatch");
  const files = ["package.json", "tsconfig.json", ...(name === "task-checkpoint-record" ? ["bin/task-checkpoint-record", BUN_CONFIG_RELATIVE] : ["bin/ultrafast-atif-helper.mjs"])].map(path => ({ path, sha256: fileHash(join(root, path)), mode: lstatSync(join(root, path)).mode & 0o777 }));
  files.push(...fileList(join(root, "src")).map(f => ({ ...f, path: `src/${f.path}` })));
  for (const path of ["bun.lock", "package-lock.json"]) if (stat(join(root, path))) files.push({ path, sha256: fileHash(join(root, path)), mode: lstatSync(join(root, path)).mode & 0o777 });
  return { name, root, version: string(pkg.version), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
function run(executable: string, args: string[], cwd: string): string {
  const r = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 60000, maxBuffer: CAP,
    env: { PATH: dirname(executable), LANG: "C.UTF-8", TASK_CHECKPOINT_RECORD_ROLE: "observer" } });
  if (r.error || r.status !== 0) fail("build_or_probe_failed"); return r.stdout;
}
function bunFlags(configPath: string): string[] { return ["--no-env-file", "--no-install", `--config=${configPath}`]; }
function runtime(path: string, bunConfig?: string): Runtime {
  safePath(path); if (!(lstatSync(path).mode & 0o111)) fail("runtime_not_executable");
  return { path, sha256: fileHash(path), version: string(run(path, [...(bunConfig ? bunFlags(bunConfig) : []), "--version"], dirname(path)).trim()) };
}
export function snapshot(p: string): Snapshot {
  safePath(p, true); if (!stat(p)) return { exists: false, sha256: null, bytes: null, mode: null };
  const s = lstatSync(p); if (s.uid !== process.getuid?.() || (s.mode & 0o022)) fail("file_not_owned_or_writable_by_others");
  const bytes = readSafe(p); return { exists: true, sha256: sha(bytes), bytes: bytes.toString("base64"), mode: s.mode & 0o777 };
}
export function equalSnapshot(p: string, wanted: Snapshot): void {
  if (canonical(snapshot(p)) !== canonical(wanted)) fail("precondition_changed");
}
function rootOf(prefix: string) { return join(prefix, ".task-checkpoint-record"); }
function currentPath(prefix: string) { return join(rootOf(prefix), "current.json"); }
function ownerBytes() { return canonical({ schema_version: "task-checkpoint-record.install-owner.v1", owner: OWNER }) + "\n"; }
export function artifactCommand(manifestPath: string, name: typeof COMMANDS[number]): string[] {
  const manifest = verifyManifest(manifestPath), dir = dirname(manifestPath);
  if (name === "task-checkpoint-record") {
    if (manifest.bun_config_path !== BUN_CONFIG_RELATIVE) fail("bun_runtime_config_required");
    return ["/usr/bin/env", "-u", "BUN_OPTIONS", manifest.runtimes.bun.path, ...bunFlags(join(dir, BUN_CONFIG_RELATIVE)), join(dir, "record", "cli.mjs")];
  }
  return [manifest.runtimes.node.path, join(dir, "helper", "bin", "ultrafast-atif-helper.mjs")];
}
function launcher(manifest: Manifest, directory: string, name: typeof COMMANDS[number]): string {
  const hardened = name === "task-checkpoint-record" && manifest.bun_config_path === BUN_CONFIG_RELATIVE;
  const argv = name === "task-checkpoint-record" ? [manifest.runtimes.bun.path, ...(hardened ? bunFlags(join(directory, BUN_CONFIG_RELATIVE)) : ["--no-env-file"]), join(directory, "record", "cli.mjs")] : [manifest.runtimes.node.path, join(directory, "helper", "bin", "ultrafast-atif-helper.mjs")];
  return `#!/bin/sh\n# Owned by ${OWNER}; verify with scripts/install-cli.ts\n${hardened ? "unset BUN_OPTIONS\n" : ""}exec ${argv.map(shellQuote).join(" ")} "$@"\n`;
}
function validateManifest(m: any): asserts m is Manifest {
  if (m?.schema_version !== "task-checkpoint-record.install-manifest.v1" || m.owner !== OWNER || !Array.isArray(m.files) || !m.files.length || m.files.length > 4096) fail("invalid_manifest");
  const seen = new Set<string>();
  for (const f of m.files) {
    string(f.path); if (isAbsolute(f.path) || f.path.includes("\\") || f.path.split("/").some((s: string) => !s || s === "." || s === "..") || f.path === "manifest.json" || seen.has(f.path)) fail("invalid_artifact_path");
    seen.add(f.path); if (!/^[a-f0-9]{64}$/.test(f.sha256) || ![0o600, 0o644, 0o700, 0o755].includes(f.mode)) fail("invalid_artifact_metadata");
  }
  if (m.bun_config_path !== undefined && (m.bun_config_path !== BUN_CONFIG_RELATIVE || !seen.has(BUN_CONFIG_RELATIVE))) fail("invalid_bun_runtime_config");
  for (const name of ["bun", "node"] as const) { const r = m.runtimes?.[name]; absolute(r?.path); if (!/^[a-f0-9]{64}$/.test(r.sha256)) fail("invalid_runtime"); }
}
export function verifyManifest(manifestPath: string): Manifest {
  const m = json(manifestPath); validateManifest(m); const dir = dirname(manifestPath);
  if (dirname(dir).endsWith("/versions") && !dir.split(sep).at(-1)!.startsWith(".stage-") && dir.split(sep).at(-1) !== sha(canonical(m))) fail("version_directory_mismatch");
  const actual = fileList(dir).filter(f => f.path !== "manifest.json");
  if (canonical(actual) !== canonical(m.files)) fail("artifact_changed");
  if (m.distribution) {
    const d = m.distribution, releaseBytes = readSafe(join(dir, "release-bundle.json"));
    if (sha(releaseBytes) !== d.manifest_sha256 || canonical(JSON.parse(releaseBytes.toString())) !== canonical(d.release)) fail("installed_release_metadata_changed");
    for (const key of ["recorder", "helper"] as const) {
      const path = key === "recorder" ? "licenses/task-checkpoint-record.LICENSE" : "licenses/ultrafast-atif-helper.LICENSE";
      if (d.installed_licenses[key] !== path || fileHash(join(dir, path)) !== d.release[key].license.sha256) fail("installed_release_license_changed");
    }
  }
  for (const name of ["bun", "node"] as const) if (fileHash(m.runtimes[name].path) !== m.runtimes[name].sha256) fail("runtime_changed");
  return m;
}
function before(prefix: string): InstallPlan["before"] {
  ownedDirectory(prefix); const root = rootOf(prefix), commands: Record<string, Snapshot> = {};
  let current: Snapshot = { exists: false, sha256: null, bytes: null, mode: null };
  if (stat(root)) {
    ownedDirectory(root); if (readSafe(join(root, "owner.json")).toString() !== ownerBytes()) fail("foreign_install_root");
    current = snapshot(currentPath(prefix));
  }
  const installed = current.exists ? JSON.parse(Buffer.from(current.bytes!, "base64").toString()) : null;
  if (installed && (installed.schema_version !== "task-checkpoint-record.current-install.v1" || installed.owner !== OWNER || !/^[a-f0-9]{64}$/.test(installed.version_id))) fail("foreign_install_record");
  const installedManifest = installed ? verifyManifest(join(root, "versions", installed.version_id, "manifest.json")) : null;
  for (const name of COMMANDS) {
    const s = snapshot(join(prefix, name)); commands[name] = s;
    if (s.exists && (!installed || s.sha256 !== installed.commands?.[name]?.sha256 || s.mode !== 0o755)) fail("foreign_or_modified_command");
    if (s.exists && installedManifest && s.sha256 !== sha(launcher(installedManifest, join(root, "versions", installed.version_id), name))) fail("foreign_or_modified_command");
    if (installed && !s.exists) fail("owned_command_missing");
  }
  return { current, commands };
}
export function planBuiltArtifacts(stage: string, prefix: string, manifest: Manifest): InstallPlan {
  // Exported for offline packagers/tests; caller must provide a separately reviewed artifact manifest.
  ownedDirectory(stage); validateManifest(manifest);
  if (manifest.bun_config_path !== BUN_CONFIG_RELATIVE) fail("bun_runtime_config_required");
  if (canonical(fileList(stage)) !== canonical(manifest.files)) fail("artifact_changed");
  const preconditions = before(prefix); writeNew(join(stage, "manifest.json"), canonical(manifest) + "\n");
  return { schema_version: "task-checkpoint-record.install-plan.v1", owner: OWNER, plan_only: true, stage, prefix, version_id: sha(canonical(manifest)), manifest, before: preconditions };
}
type BuildOptions = { recordRepo: string; helperRepo: string; prefix: string; stage: string; bun: string; node: string };
export function preparePlan(o: BuildOptions): InstallPlan { return prepareSources(o); }
export function prepareBundlePlan(o: { bundleRoot: string; bundleSha256: string; prefix: string; stage: string; bun: string; node: string }): InstallPlan {
  absolute(o.bundleRoot);
  // A stage below the unpacked release would mutate the very inventory we pin.
  const rel = relative(o.bundleRoot, absolute(o.stage)); if (!rel || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) fail("stage_inside_release_bundle");
  const release = verifyReleaseBundle(o.bundleRoot, o.bundleSha256);
  return prepareSources({ recordRepo: o.bundleRoot, helperRepo: join(o.bundleRoot, release.helper.root), prefix: o.prefix, stage: o.stage, bun: o.bun, node: o.node },
    { manifest_sha256: o.bundleSha256, release, installed_licenses: { recorder: "licenses/task-checkpoint-record.LICENSE", helper: "licenses/ultrafast-atif-helper.LICENSE" } });
}
function prepareSources(o: BuildOptions, distribution?: Manifest["distribution"]): InstallPlan {
  for (const p of Object.values(o)) absolute(p); before(o.prefix); safePath(o.stage, true);
  if (stat(o.stage)) fail("stage_must_be_new"); ownedDirectory(dirname(o.stage));
  const sources = [source(o.recordRepo, COMMANDS[0]), source(o.helperRepo, COMMANDS[1])];
  const runtimes = { bun: runtime(o.bun, join(o.recordRepo, BUN_CONFIG_RELATIVE)), node: runtime(o.node) };
  mkdirSync(o.stage, { mode: 0o700 });
  for (const path of ["config", "record", "helper", "helper/bin", "helper/dist", "helper/dist/helper"]) mkdirSync(join(o.stage, path), { mode: 0o700 });
  writeNew(join(o.stage, BUN_CONFIG_RELATIVE), readSafe(join(o.recordRepo, BUN_CONFIG_RELATIVE)), 0o644);
  run(o.bun, [...bunFlags(join(o.stage, BUN_CONFIG_RELATIVE)), "build", join(o.recordRepo, "src/cli.ts"), "--target=bun", "--outfile", join(o.stage, "record/cli.mjs")], o.stage);
  run(o.bun, [...bunFlags(join(o.stage, BUN_CONFIG_RELATIVE)), "build", join(o.helperRepo, "src/helper/cli.ts"), "--target=node", "--outfile", join(o.stage, "helper/dist/helper/cli.js")], o.stage);
  writeNew(join(o.stage, "helper/bin/ultrafast-atif-helper.mjs"), readSafe(join(o.helperRepo, "bin/ultrafast-atif-helper.mjs")), 0o644);
  writeNew(join(o.stage, "helper/package.json"), canonical({ name: sources[1].name, version: sources[1].version, type: "module" }) + "\n", 0o644);
  if (distribution) {
    mkdirSync(join(o.stage, "licenses"), { mode: 0o700 });
    for (const key of ["recorder", "helper"] as const) writeNew(join(o.stage, distribution.installed_licenses[key]), readSafe(join(o.recordRepo, distribution.release[key].license.path)), 0o644);
    writeNew(join(o.stage, "release-bundle.json"), readSafe(join(o.recordRepo, "release-bundle.json")), 0o644);
  }
  const helpChecks = COMMANDS.map(name => {
    const argv = name === COMMANDS[0] ? [o.bun, ...bunFlags(join(o.stage, BUN_CONFIG_RELATIVE)), join(o.stage, "record/cli.mjs")] : [o.node, join(o.stage, "helper/bin/ultrafast-atif-helper.mjs")];
    const stdout = run(argv[0], [...argv.slice(1), "--help"], o.stage); const parsed = JSON.parse(stdout);
    if (!parsed.commands || (name === COMMANDS[0] ? parsed.name !== name : parsed.schema_version !== "ultrafast-atif.cli.v1")) fail("help_contract_mismatch");
    return { name, stdout_sha256: sha(stdout), exit_code: 0 as const };
  });
  if (canonical(sources) !== canonical([source(o.recordRepo, COMMANDS[0]), source(o.helperRepo, COMMANDS[1])])) fail("source_changed_during_build");
  if (distribution && canonical(verifyReleaseBundle(o.recordRepo, distribution.manifest_sha256)) !== canonical(distribution.release)) fail("release_changed_during_build");
  return planBuiltArtifacts(o.stage, o.prefix, { schema_version: "task-checkpoint-record.install-manifest.v1", owner: OWNER, sources, runtimes, bun_config_path: BUN_CONFIG_RELATIVE, files: fileList(o.stage), help_checks: helpChecks, ...(distribution ? { distribution } : {}) });
}
function validatePlan(p: any): asserts p is InstallPlan {
  if (p?.schema_version !== "task-checkpoint-record.install-plan.v1" || p.owner !== OWNER || p.plan_only !== true) fail("invalid_plan");
  absolute(p.stage); absolute(p.prefix); validateManifest(p.manifest);
  if (p.version_id !== sha(canonical(p.manifest))) fail("manifest_digest_mismatch");
  if (!p.before?.current || Object.keys(p.before.commands ?? {}).sort().join() !== [...COMMANDS].sort().join()) fail("invalid_preconditions");
}
export function atomicSet(p: string, wanted: Snapshot): void {
  if (!wanted.exists) { if (stat(p)) unlinkSync(p); return; }
  const path = join(dirname(p), `.${p.split(sep).at(-1)}.${randomUUID()}.tmp`);
  writeNew(path, Buffer.from(wanted.bytes!, "base64"), wanted.mode!);
  try { renameSync(path, p); } finally { if (stat(path)) unlinkSync(path); }
}
function asSnapshot(bytes: string, mode = 0o600): Snapshot { return { exists: true, sha256: sha(bytes), bytes: Buffer.from(bytes).toString("base64"), mode }; }
function ensureDir(p: string): void { safePath(dirname(p)); if (!stat(p)) mkdirSync(p, { mode: 0o700 }); ownedDirectory(p); }
function lock<T>(prefix: string, fn: () => T): T {
  ownedDirectory(prefix); const p = join(prefix, ".task-checkpoint-record.install.lock"); writeNew(p, canonical({ owner: OWNER, pid: process.pid }) + "\n");
  try { return fn(); } finally { unlinkSync(p); }
}
export function applyPlan(plan: InstallPlan): any {
  validatePlan(plan);
  if (plan.manifest.bun_config_path !== BUN_CONFIG_RELATIVE) fail("bun_runtime_config_required");
  return lock(plan.prefix, () => {
    const root = rootOf(plan.prefix), dir = join(root, "versions", plan.version_id);
    const desiredCommands = Object.fromEntries(COMMANDS.map(name => [name, asSnapshot(launcher(plan.manifest, dir, name), 0o755)]));
    const desiredCurrent = asSnapshot(canonical({ schema_version: "task-checkpoint-record.current-install.v1", owner: OWNER, version_id: plan.version_id,
      commands: Object.fromEntries(COMMANDS.map(name => [name, { sha256: desiredCommands[name].sha256 }])) }) + "\n");
    const current = before(plan.prefix);
    if (canonical(current) === canonical({ current: desiredCurrent, commands: desiredCommands })) return { schema_version: "task-checkpoint-record.install-receipt.v1", owner: OWNER, disposition: "already_applied", prefix: plan.prefix, version_id: plan.version_id, before: plan.before, after: current };
    if (canonical(current) !== canonical(plan.before)) fail("precondition_changed");
    if (canonical(verifyManifest(join(plan.stage, "manifest.json"))) !== canonical(plan.manifest)) fail("stage_manifest_changed");
    ensureDir(root); if (!stat(join(root, "owner.json"))) writeNew(join(root, "owner.json"), ownerBytes());
    ensureDir(join(root, "versions"));
    if (stat(dir)) { if (canonical(verifyManifest(join(dir, "manifest.json"))) !== canonical(plan.manifest)) fail("existing_version_conflict"); }
    else {
      const temp = join(root, "versions", `.stage-${randomUUID()}`); mkdirSync(temp, { mode: 0o700 });
      try {
        for (const f of [...plan.manifest.files, { path: "manifest.json", sha256: fileHash(join(plan.stage, "manifest.json")), mode: 0o600 }]) {
          let parent = temp; for (const component of dirname(f.path).split(sep).filter(x => x !== ".")) { parent = join(parent, component); ensureDir(parent); }
          const bytes = readSafe(join(plan.stage, f.path)); if (sha(bytes) !== f.sha256) fail("staged_artifact_changed"); writeNew(join(temp, f.path), bytes, f.mode);
        }
        verifyManifest(join(temp, "manifest.json")); renameSync(temp, dir);
      } catch (e) { rmSync(temp, { recursive: true, force: true }); throw e; }
    }
    const modified: string[] = [];
    try {
      for (const name of COMMANDS) { equalSnapshot(join(plan.prefix, name), plan.before.commands[name]); atomicSet(join(plan.prefix, name), desiredCommands[name]); modified.push(name); }
      equalSnapshot(currentPath(plan.prefix), plan.before.current); atomicSet(currentPath(plan.prefix), desiredCurrent);
    } catch (e) {
      for (const name of modified.reverse()) { equalSnapshot(join(plan.prefix, name), desiredCommands[name]); atomicSet(join(plan.prefix, name), plan.before.commands[name]); }
      throw e;
    }
    const after = before(plan.prefix);
    if (canonical(after) !== canonical({ current: desiredCurrent, commands: desiredCommands })) fail("verification_failed");
    return { schema_version: "task-checkpoint-record.install-receipt.v1", owner: OWNER, disposition: "applied", prefix: plan.prefix, version_id: plan.version_id, before: plan.before, after };
  });
}
export function verifyInstall(prefix: string): any {
  const result = before(prefix); if (!result.current.exists) fail("not_installed");
  const current = JSON.parse(Buffer.from(result.current.bytes!, "base64").toString());
  return { schema_version: "task-checkpoint-record.install-verification.v1", owner: OWNER, prefix, version_id: current.version_id, verified: true, command_hashes: Object.fromEntries(COMMANDS.map(n => [n, result.commands[n].sha256])), native_hooks_verified: false, services_started: false };
}
function validateRollbackTarget(prefix: string, target: InstallPlan["before"]): void {
  if (!target || !target.current || Object.keys(target.commands ?? {}).sort().join() !== [...COMMANDS].sort().join()) fail("invalid_rollback_target");
  const validateSnapshot = (value: Snapshot, mode: number): void => {
    if (!value || typeof value.exists !== "boolean") fail("invalid_rollback_snapshot");
    if (!value.exists) { if (value.sha256 !== null || value.bytes !== null || value.mode !== null) fail("invalid_rollback_snapshot"); return; }
    if (typeof value.bytes !== "string" || value.bytes.length > CAP * 2 || !/^[a-f0-9]{64}$/.test(value.sha256 ?? "") || value.mode !== mode) fail("invalid_rollback_snapshot");
    const bytes = Buffer.from(value.bytes, "base64");
    if (bytes.length > CAP || bytes.toString("base64") !== value.bytes || sha(bytes) !== value.sha256) fail("invalid_rollback_snapshot");
  };
  validateSnapshot(target.current, 0o600);
  for (const name of COMMANDS) validateSnapshot(target.commands[name], 0o755);
  if (!target.current.exists) {
    if (COMMANDS.some(name => target.commands[name].exists)) fail("invalid_rollback_target");
    return;
  }
  let current: any;
  try { current = JSON.parse(Buffer.from(target.current.bytes!, "base64").toString()); } catch { fail("invalid_rollback_target"); }
  if (current?.schema_version !== "task-checkpoint-record.current-install.v1" || current.owner !== OWNER || !/^[a-f0-9]{64}$/.test(current.version_id ?? "")) fail("invalid_rollback_target");
  const directory = join(rootOf(prefix), "versions", current.version_id);
  // Retired versions and runtimes may have changed while the current version
  // remained healthy. Validate the complete target before restoring anything.
  const manifest = verifyManifest(join(directory, "manifest.json"));
  const commands = Object.fromEntries(COMMANDS.map(name => [name, asSnapshot(launcher(manifest, directory, name), 0o755)]));
  const expectedCurrent = asSnapshot(canonical({ schema_version: "task-checkpoint-record.current-install.v1", owner: OWNER, version_id: current.version_id,
    commands: Object.fromEntries(COMMANDS.map(name => [name, { sha256: commands[name].sha256 }])) }) + "\n");
  if (canonical(target) !== canonical({ current: expectedCurrent, commands })) fail("invalid_rollback_target");
}
export function rollbackInstall(receipt: any): any {
  if (receipt?.schema_version !== "task-checkpoint-record.install-receipt.v1" || receipt.owner !== OWNER || receipt.disposition !== "applied") fail("not_an_applied_receipt");
  absolute(receipt.prefix); return lock(receipt.prefix, () => {
    if (canonical(before(receipt.prefix)) !== canonical(receipt.after)) fail("rollback_precondition_changed");
    validateRollbackTarget(receipt.prefix, receipt.before);
    for (const name of COMMANDS) atomicSet(join(receipt.prefix, name), receipt.before.commands[name]);
    atomicSet(currentPath(receipt.prefix), receipt.before.current);
    return { schema_version: "task-checkpoint-record.install-rollback.v1", owner: OWNER, restored: canonical(before(receipt.prefix)) === canonical(receipt.before), immutable_versions_retained: true };
  });
}
export function flags(argv: string[], allowed: string[]): { command: string; values: Record<string, string> } {
  if (argv.length > 64) fail("argument_budget"); const command = argv.shift() ?? "help", values: Record<string, string> = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i].replace(/^--/, ""); if (!argv[i].startsWith("--") || !allowed.includes(key) || Object.hasOwn(values, key) || !argv[i + 1]) fail("invalid_option"); values[key] = string(argv[i + 1]); }
  return { command, values };
}
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
if (import.meta.main) {
  try {
    const { command, values: v } = flags(process.argv.slice(2), ["record-repo", "helper-repo", "bundle-root", "bundle-sha256", "prefix", "stage", "bun", "node", "output", "plan", "receipt", "sha256"]);
    if (["help", "--help"].includes(command)) emit({ schema_version: "task-checkpoint-record.installer-help.v1", commands: {
      plan: "--record-repo ABS --helper-repo ABS --prefix EXISTING_BIN_DIR --stage NEW_ABS_DIR --bun REAL_EXEC --node REAL_EXEC --output NEW_PLAN_JSON",
      "bundle-plan": "--bundle-root UNPACKED_RELEASE --bundle-sha256 REVIEWED_RELEASE_MANIFEST_SHA --prefix EXISTING_BIN_DIR --stage NEW_ABS_DIR --bun REAL_EXEC --node REAL_EXEC --output NEW_PLAN_JSON",
      apply: "--plan ABS_JSON --sha256 REVIEWED_PLAN_SHA --output NEW_RECEIPT_JSON",
      verify: "--prefix EXISTING_BIN_DIR",
      rollback: "--receipt ABS_JSON --sha256 REVIEWED_RECEIPT_SHA --output NEW_ROLLBACK_JSON"
    }, effects: "plan builds only in the explicit new stage; apply/rollback are explicit local registration; no PATH, package-manager, auth, hooks, model or service effects" });
    else if (command === "plan" || command === "bundle-plan") {
      if (command === "bundle-plan" && (v["record-repo"] || v["helper-repo"])) fail("bundle_external_source_forbidden");
      if (command === "plan" && (v["bundle-root"] || v["bundle-sha256"])) fail("ambiguous_source_mode");
      const p = command === "bundle-plan" ? prepareBundlePlan({ bundleRoot: v["bundle-root"], bundleSha256: v["bundle-sha256"], prefix: v.prefix, stage: v.stage, bun: v.bun, node: v.node }) : preparePlan({ recordRepo: v["record-repo"], helperRepo: v["helper-repo"], prefix: v.prefix, stage: v.stage, bun: v.bun, node: v.node });
      const body = JSON.stringify(p, null, 2) + "\n"; writeNew(absolute(v.output), body); emit({ plan: v.output, sha256: sha(body), version_id: p.version_id, plan_only: true });
    }
    else if (command === "verify") emit(verifyInstall(absolute(v.prefix)));
    else if (["apply", "rollback"].includes(command)) {
      const output = absolute(v.output), inputPath = absolute(command === "apply" ? v.plan : v.receipt);
      const input = checkedJSON(inputPath, v.sha256);
      const prefix = absolute(input.prefix);
      const protectedPaths = [rootOf(prefix), ...COMMANDS.map(name => join(prefix, name)), join(prefix, ".task-checkpoint-record.install.lock"), ...(command === "apply" ? [absolute(input.stage)] : [])];
      const result = withReceipt(output, { operation: command, path: inputPath, sha256: v.sha256, value: input }, () => command === "apply" ? applyPlan(input) : rollbackInstall(input), protectedPaths);
      emit({ receipt: output, ...result });
    } else fail("unknown_command");
  } catch (e) { emit({ schema_version: "task-checkpoint-record.installer-error.v1", error: e instanceof InstallError ? e.code : "operation_failed",
    ...(e instanceof ReceiptOperationError ? { recovery: e.recovery, ...(e.effect_result !== undefined ? { effect_result: e.effect_result } : {}) } : {}) }); process.exitCode = 1; }
}

import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { Fingerprint, TelemetryCorrelation } from "./types.ts";

export class TcrError extends Error {
  constructor(readonly code: string) { super(code); this.name = "TcrError"; }
}
export function fail(code: string): never { throw new TcrError(code); }
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
export function object(value: unknown): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_object");
  return value as Record<string, any>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail("unknown_field");
}
export function str(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail("invalid_string");
  return value;
}
export function nullable(value: unknown, max = 512): string | null { return value === null ? null : str(value, max); }
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("invalid_integer");
  return value;
}
export function bool(value: unknown): boolean { if (typeof value !== "boolean") fail("invalid_boolean"); return value; }
export function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) fail("invalid_enum"); return value as T;
}
export function digest(value: unknown): string {
  const s = str(value, 64); if (!/^[a-f0-9]{64}$/.test(s)) fail("invalid_digest"); return s;
}
export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return fail("invalid_json"); }
}
export function safeError(error: unknown): string {
  return error instanceof TcrError ? error.code : "operation_failed";
}
export function absolute(path: unknown): string {
  const p = str(path, 4096);
  if (!isAbsolute(p) || resolve(p) !== p) fail("noncanonical_path");
  return p;
}
export function denyCredential(path: string): void {
  const components = path.toLowerCase().split(sep);
  if (components.some(c => [".ssh", ".gnupg", "keychains", ".aws", ".azure"].includes(c) || /^(auth|credentials|secrets|tokens?)(\.|$)/.test(c) || /^\.env($|\.)/.test(c) || /\.(pem|key|p12|pfx|keychain-db)$/.test(c))) fail("credential_path_denied");
}
export function noSymlinks(path: string, allowMissingLeaf = false): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      // lstat sees dangling symlinks; existsSync deliberately does not.
      try { if (lstatSync(current).isSymbolicLink()) fail("symlink_denied"); } catch (e) { if (e instanceof TcrError) throw e; }
      if (allowMissingLeaf && current === path) return;
      fail("path_missing");
    }
    if (lstatSync(current).isSymbolicLink()) fail("symlink_denied");
  }
}
export function underRoot(path: string, root: string): void {
  absolute(path); absolute(root); denyCredential(path);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) fail("source_outside_root");
  noSymlinks(root); noSymlinks(path);
  if (!statSync(root).isDirectory()) fail("invalid_source_root");
}
export function openRegular(path: string): number {
  absolute(path); denyCredential(path); noSymlinks(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return fail("source_open_failed"); }
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) { closeSync(fd); fail("nonregular_or_aliased_file"); }
  return fd;
}
export function range(fd: number, offset: number, length: number): Buffer {
  integer(offset, 0, Number.MAX_SAFE_INTEGER); integer(length, 0, 8 * 1024 * 1024);
  const b = Buffer.alloc(length); let total = 0;
  while (total < length) {
    const n = readSync(fd, b, total, length - total, offset + total);
    if (n === 0) fail("source_truncated"); total += n;
  }
  return b;
}
export function readFileBounded(path: string, cap: number): Buffer {
  const fd = openRegular(path);
  try { const size = fstatSync(fd).size; integer(size, 0, cap); return range(fd, 0, size); } finally { closeSync(fd); }
}
export function fingerprint(fd: number, cursor: number): Fingerprint {
  const info = fstatSync(fd);
  if (info.size < cursor) fail("source_truncated");
  const len = Math.min(cursor, 4096);
  return { dev: info.dev, ino: info.ino, cursor, head: sha(range(fd, 0, len)), tail: sha(range(fd, cursor - len, len)) };
}
export function checkFingerprint(fd: number, previous: string | null, cursor: number): void {
  if (previous && canonical(fingerprint(fd, cursor)) !== previous) fail("source_rotated_or_changed");
}
export function privateState(path: string, create = false): string {
  absolute(path); denyCredential(path);
  if (create && !existsSync(path)) {
    // Create only beneath a real existing ancestor; do not repair unrelated modes.
    const missing: string[] = []; let p = path;
    while (!existsSync(p)) { missing.unshift(p); p = dirname(p); }
    noSymlinks(p);
    for (const dir of missing) { mkdirSync(dir, { mode: 0o700 }); noSymlinks(dir); }
  }
  noSymlinks(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) fail("state_not_private");
  for (const suffix of ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"]) {
    const file = resolve(path, suffix);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077)) fail("unsafe_database_file");
    } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  }
  return realpathSync(path);
}
export function limitedJSON(value: unknown, maxBytes = 128 * 1024): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) fail("output_budget_exceeded"); return json;
}
export function childEnvironment(role: "observer" | "worker", parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const key of ["HOME","PATH","USER","LOGNAME","TMPDIR","TEMP","TMP","LANG","LC_ALL","TZ","SystemRoot","WINDIR","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy","SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS"])
    if(parent[key]!==undefined)env[key]=parent[key];
  env.TASK_CHECKPOINT_RECORD_ROLE=role;
  env.TASK_CHECKPOINT_RECORD_WORKER="1";
  return env;
}
export function telemetryCorrelation(value?:unknown):TelemetryCorrelation {
  if(value===undefined)return{namespace:"opentelemetry.w3c",source:"unavailable",trace_id:null,span_id:null};
  const t=object(value);keys(t,["namespace","source","trace_id","span_id"]);
  if(t.namespace!=="opentelemetry.w3c")fail("telemetry_namespace_unsupported");
  const source=oneOf(t.source,["explicit_adapter","unavailable"] as const);
  const id=(raw:unknown,width:number)=>{if(raw===null)return null;const s=str(raw,width);if(!new RegExp(`^[a-f0-9]{${width}}$`).test(s)||/^0+$/.test(s))fail("invalid_telemetry_id");return s;};
  const trace_id=id(t.trace_id,32),span_id=id(t.span_id,16);
  if((span_id!==null&&trace_id===null)||(source==="unavailable"&&(trace_id!==null||span_id!==null)))fail("invalid_telemetry_correlation");
  return{namespace:"opentelemetry.w3c",source,trace_id,span_id};
}

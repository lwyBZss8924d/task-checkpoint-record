/** Native JSON definition planning. This never edits config.toml or native trust. */
import { lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER, InstallError, ReceiptOperationError, absolute, artifactCommand, atomicSet, canonical, checkedJSON, equalSnapshot, fail, fileHash, flags, ownedDirectory, readSafe, safePath, sha, shellQuote, snapshot, string, verifyManifest, withReceipt, writeNew } from "./install-cli.ts";

const SCHEMA = "task-checkpoint-record.hook-plan.v1";
const EVENTS = {
  codex: ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Interrupt", "SessionEnd", "Stop"],
  claude: ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "SessionEnd", "Stop"]
} as const;
type Client = keyof typeof EVENTS;
type Group = { matcher?: string; hooks: { type: "command"; command: string; timeout: number; async: false }[] };
type Addition = { event: string; index: number; group: Group; definition_sha256: string; disposition: "append" | "already_present" };
export type HookPlan = {
  schema_version: typeof SCHEMA; owner: string; plan_only: true; client: Client;
  config: string; before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot>;
  artifact_manifest: string; artifact_manifest_sha256: string; artifact_version: string;
  state: string; profile_home: string; additions: Addition[];
  native_trust: { state: "not_checked_or_modified"; definition_digest_is_native_trusted_hash: false; activated: false };
  policy: { synchronous_enqueue: true; stop: "advisory_only"; start_model_or_service: false; unbound_sessions: "inert"; cached_context_events: string[] };
};
function object(x: unknown): Record<string, any> {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail("config_object_required"); return x as Record<string, any>;
}
function parseConfig(bytes: Buffer): Record<string, any> {
  // JSON only: no evaluation, environment expansion, JSONC, TOML or credential scanning.
  const text = bytes.toString("utf8"); let value: unknown; try { value = JSON.parse(text); } catch { fail("invalid_config_json"); }
  // JSON.parse drops duplicate members. Reject them rather than silently losing
  // unrelated settings during a merge. Syntax was validated above.
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? "") && at < text.length) at++; };
  const quoted = () => { const start = at++; while (at < text.length) { const c = text[at++]; if (c === "\\") at++; else if (c === '"') return JSON.parse(text.slice(start, at)) as string; } return fail("invalid_config_json"); };
  const scan = (depth: number): void => {
    if (depth > 128) fail("config_depth_exceeded"); whitespace(); const c = text[at];
    if (c === '"') { quoted(); return; }
    if (c === "{") { at++; whitespace(); const seen = new Set<string>(); if (text[at] === "}") { at++; return; }
      while (at < text.length) { whitespace(); const key = quoted(); if (seen.has(key)) fail("duplicate_config_key"); seen.add(key); whitespace(); at++; scan(depth + 1); whitespace(); if (text[at++] === "}") return; }
    } else if (c === "[") { at++; whitespace(); if (text[at] === "]") { at++; return; } while (at < text.length) { scan(depth + 1); whitespace(); if (text[at++] === "]") return; } }
    else while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  };
  scan(0);
  const config = object(value); if (Object.hasOwn(config, "hooks")) object(config.hooks);
  return config;
}
function definition(client: Client, event: string, command: string): Group {
  const group: Group = { hooks: [{ type: "command", command, timeout: event === "SessionEnd" || event === "Interrupt" ? 1 : 2, async: false }] };
  if (event === "SessionStart") group.matcher = client === "codex" ? "startup|resume|clear|compact" : "startup|resume|clear|compact";
  return group;
}
export function mergeHooks(configBytes: Buffer, client: Client, command: string): { bytes: Buffer; additions: Addition[] } {
  if (!Object.hasOwn(EVENTS, client)) fail("unsupported_client"); string(command);
  const config = parseConfig(configBytes), desired = structuredClone(config), hooks = desired.hooks ?? (desired.hooks = {});
  const additions: Addition[] = [];
  for (const event of EVENTS[client]) {
    if (Object.hasOwn(hooks, event) && !Array.isArray(hooks[event])) fail("invalid_event_groups");
    const groups: any[] = hooks[event] ?? (hooks[event] = []), group = definition(client, event, command);
    let existing = -1;
    for (let i = 0; i < groups.length; i++) {
      const current = object(groups[i]); if (!Array.isArray(current.hooks)) fail("invalid_hook_group");
      if (current.hooks.some((h: any) => typeof h?.command === "string" && h.command !== command && h.command.includes("/.task-checkpoint-record/versions/") && h.command.includes("/record/cli.mjs"))) fail("previous_version_requires_owned_rollback");
      if (canonical(current) === canonical(group)) { if (existing !== -1) fail("duplicate_owned_definition"); existing = i; }
      else if (current.hooks.some((h: any) => h?.command === command)) fail("conflicting_existing_definition");
    }
    const index = existing < 0 ? groups.length : existing;
    additions.push({ event, index, group, definition_sha256: sha(canonical({ client, event, group })), disposition: existing < 0 ? "append" : "already_present" });
    if (existing < 0) groups.push(group);
  }
  // Exact byte identity on an idempotent re-plan; otherwise preserve every unrelated JSON value and array position.
  const bytes = additions.every(x => x.disposition === "already_present") ? configBytes : Buffer.from(JSON.stringify(desired, null, 2) + "\n");
  return { bytes, additions };
}
function expectedCommand(manifestPath: string, state: string, client: Client, profile: string): string {
  return [...artifactCommand(manifestPath, "task-checkpoint-record"), "hook", "--state", state, "--client", client, "--profile", profile].map(shellQuote).join(" ");
}
function privateDirectory(p: string): void {
  ownedDirectory(p); if (lstatSync(p).mode & 0o077) fail("state_or_profile_not_private");
}
export function createHookPlan(o: { client: Client; config: string; manifest: string; state: string; profile: string }): HookPlan {
  if (!Object.hasOwn(EVENTS, o.client)) fail("unsupported_client");
  for (const p of [o.config, o.manifest, o.state, o.profile]) absolute(p);
  privateDirectory(o.state); privateDirectory(o.profile); ownedDirectory(dirname(o.config));
  const manifest = verifyManifest(o.manifest), version = sha(canonical(manifest));
  if (dirname(o.manifest).split("/").at(-1) !== version || dirname(dirname(o.manifest)).split("/").at(-1) !== "versions") fail("immutable_installed_artifact_required");
  const before = snapshot(o.config), original = before.exists ? Buffer.from(before.bytes!, "base64") : Buffer.from("{}\n");
  const merged = mergeHooks(original, o.client, expectedCommand(o.manifest, o.state, o.client, o.profile));
  return {
    schema_version: SCHEMA, owner: OWNER, plan_only: true, client: o.client, config: o.config, before,
    after: { exists: true, sha256: sha(merged.bytes), bytes: merged.bytes.toString("base64"), mode: before.mode ?? 0o600 },
    artifact_manifest: o.manifest, artifact_manifest_sha256: fileHash(o.manifest), artifact_version: version,
    state: o.state, profile_home: o.profile, additions: merged.additions,
    native_trust: { state: "not_checked_or_modified", definition_digest_is_native_trusted_hash: false, activated: false },
    policy: { synchronous_enqueue: true, stop: "advisory_only", start_model_or_service: false, unbound_sessions: "inert", cached_context_events: ["SessionStart", "UserPromptSubmit"] }
  };
}
function validatePlan(p: HookPlan): void {
  if (p?.schema_version !== SCHEMA || p.owner !== OWNER || p.plan_only !== true || !Object.hasOwn(EVENTS, p.client)) fail("invalid_hook_plan");
  for (const path of [p.config, p.artifact_manifest, p.state, p.profile_home]) absolute(path);
  privateDirectory(p.state); privateDirectory(p.profile_home); ownedDirectory(dirname(p.config));
  if (fileHash(p.artifact_manifest) !== p.artifact_manifest_sha256) fail("artifact_manifest_changed");
  const manifest = verifyManifest(p.artifact_manifest);
  if (sha(canonical(manifest)) !== p.artifact_version || dirname(p.artifact_manifest).split("/").at(-1) !== p.artifact_version) fail("artifact_version_changed");
  const original = p.before.exists ? Buffer.from(p.before.bytes!, "base64") : Buffer.from("{}\n");
  if (p.before.exists && sha(original) !== p.before.sha256) fail("before_bytes_mismatch");
  const merged = mergeHooks(original, p.client, expectedCommand(p.artifact_manifest, p.state, p.client, p.profile_home));
  if (canonical(merged.additions) !== canonical(p.additions) || merged.bytes.toString("base64") !== p.after.bytes || sha(merged.bytes) !== p.after.sha256 || p.after.mode !== (p.before.mode ?? 0o600) || p.after.exists !== true) fail("hook_plan_effects_changed");
}
function locked<T>(config: string, fn: () => T): T {
  const path = join(dirname(config), `.${config.split("/").at(-1)}.task-checkpoint-record.lock`);
  writeNew(path, canonical({ owner: OWNER, pid: process.pid }) + "\n");
  try { return fn(); } finally { unlinkSync(path); }
}
export function applyHookPlan(p: HookPlan): any {
  validatePlan(p); return locked(p.config, () => {
    const current = snapshot(p.config);
    if (canonical(current) === canonical(p.after)) return { schema_version: "task-checkpoint-record.hook-receipt.v1", owner: OWNER, disposition: "already_applied", plan: p, native_trust_verified: false, native_activation_verified: false };
    equalSnapshot(p.config, p.before); atomicSet(p.config, p.after); equalSnapshot(p.config, p.after);
    return { schema_version: "task-checkpoint-record.hook-receipt.v1", owner: OWNER, disposition: "applied", plan: p, native_trust_verified: false, native_activation_verified: false };
  });
}
export function verifyHookPlan(p: HookPlan): any {
  validatePlan(p); equalSnapshot(p.config, p.after);
  return { schema_version: "task-checkpoint-record.hook-verification.v1", definitions_verified: true, config_sha256: p.after.sha256, artifact_version: p.artifact_version,
    native_trust_verified: false, native_activation_verified: false, service_running_verified: false, binding_verified: false, note: "Observe the native hooks catalog/trust and a bounded callback receipt separately." };
}
export function rollbackHooks(receipt: any): any {
  if (receipt?.schema_version !== "task-checkpoint-record.hook-receipt.v1" || receipt.owner !== OWNER || receipt.disposition !== "applied") fail("not_an_applied_hook_receipt");
  const p = receipt.plan as HookPlan; validatePlan(p);
  return locked(p.config, () => { equalSnapshot(p.config, p.after); atomicSet(p.config, p.before); equalSnapshot(p.config, p.before);
    return { schema_version: "task-checkpoint-record.hook-rollback.v1", config_restored: true, exact_original_bytes_restored: true, trust_unchanged: true }; });
}
if (import.meta.main) {
  const output = (x: any) => process.stdout.write(JSON.stringify(x) + "\n");
  try {
    const { command, values: v } = flags(process.argv.slice(2), ["client", "config", "manifest", "state", "profile-home", "output", "plan", "receipt", "sha256"]);
    if (["help", "--help"].includes(command)) output({ schema_version: "task-checkpoint-record.hook-planner-help.v1", commands: {
      plan: "--client codex|claude --config ABS_JSON --manifest INSTALLED_MANIFEST --state EXISTING_PRIVATE_DIR --profile-home EXISTING_PRIVATE_DIR --output NEW_JSON",
      apply: "--plan ABS_JSON --sha256 REVIEWED_SHA --output NEW_RECEIPT_JSON",
      verify: "--plan ABS_JSON --sha256 REVIEWED_SHA",
      rollback: "--receipt ABS_JSON --sha256 REVIEWED_SHA --output NEW_RECEIPT_JSON"
    }, limitations: "JSON definitions only; config.toml, native trust, service start, login and Pi global loading stay separate. Definition hash is not Codex trusted_hash." });
    else if (command === "plan") {
      const p = createHookPlan({ client: v.client as Client, config: v.config, manifest: v.manifest, state: v.state, profile: v["profile-home"] });
      const bytes = JSON.stringify(p, null, 2) + "\n"; writeNew(absolute(v.output), bytes); output({ plan: v.output, sha256: sha(bytes), artifact_version: p.artifact_version, plan_only: true, additions: p.additions.map(a => ({ event: a.event, index: a.index, disposition: a.disposition })) });
    } else if (["apply", "verify", "rollback"].includes(command)) {
      const p = checkedJSON(absolute(command === "rollback" ? v.receipt : v.plan), v.sha256);
      if (command === "verify") output(verifyHookPlan(p));
      else {
        const path = absolute(v.output), plan = command === "apply" ? p : p.plan;
        const config = absolute(plan?.config), manifest = absolute(plan?.artifact_manifest);
        const receipt = withReceipt(path, { operation: `hooks_${command}`, path: absolute(command === "apply" ? v.plan : v.receipt), sha256: v.sha256, value: p },
          () => command === "apply" ? applyHookPlan(p) : rollbackHooks(p),
          [config, join(dirname(config), `.${config.split("/").at(-1)}.task-checkpoint-record.lock`), dirname(manifest)]);
        output({ receipt: path, disposition: receipt.disposition ?? "rolled_back", native_activation_verified: false });
      }
    } else fail("unknown_command");
  } catch (e) { output({ schema_version: "task-checkpoint-record.hook-planner-error.v1", error: e instanceof InstallError ? e.code : "operation_failed",
    ...(e instanceof ReceiptOperationError ? { recovery: e.recovery, ...(e.effect_result !== undefined ? { effect_result: e.effect_result } : {}) } : {}) }); process.exitCode = 1; }
}

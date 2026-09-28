import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BUN_CONFIG_RELATIVE, OWNER, ReceiptOperationError, applyPlan, fileHash, planBuiltArtifacts, sha, withReceipt, type Manifest } from "../scripts/install-cli.ts";
import { applyHookPlan, createHookPlan, mergeHooks, rollbackHooks, verifyHookPlan } from "../scripts/hook-plan.ts";
import { registerTaskCheckpointRecord } from "../integrations/pi/task-checkpoint-record.v1.ts";

const roots: string[] = [];
function setup(client: "codex" | "claude" = "codex") {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "tcr-hook-plan-"))); roots.push(p);
  for (const d of ["bin", "stage", "stage/record", "stage/config", "state", "profile"]) mkdirSync(join(p, d), { mode: 0o700 });
  const runtime = join(p, "runtime"); writeFileSync(runtime, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const artifact = join(p, "stage/record/cli.mjs"); writeFileSync(artifact, "// synthetic\n", { mode: 0o600 });
  const runtimeConfig = join(p, "stage", BUN_CONFIG_RELATIVE); writeFileSync(runtimeConfig, "# Synthetic owned runtime config.\n", { mode: 0o644 });
  const r = { path: runtime, sha256: fileHash(runtime), version: "synthetic" };
  const manifest: Manifest = { schema_version: "task-checkpoint-record.install-manifest.v1", owner: OWNER, sources: [], runtimes: { bun: r, node: r }, bun_config_path: BUN_CONFIG_RELATIVE,
    files: [{ path: BUN_CONFIG_RELATIVE, sha256: fileHash(runtimeConfig), mode: 0o644 }, { path: "record/cli.mjs", sha256: fileHash(artifact), mode: 0o600 }], help_checks: [] };
  const installed = planBuiltArtifacts(join(p, "stage"), join(p, "bin"), manifest); applyPlan(installed);
  const original = JSON.stringify({ permissions: { allow: ["Read"] }, unrelated: { nested: true }, hooks: {
    SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: "foreign-start", timeout: 30 }] }],
    Stop: [{ hooks: [{ type: "command", command: "foreign-gate", timeout: 30 }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "foreign-tool" }] }]
  } }, null, 3) + "\n";
  const config = join(p, "profile/hooks.json"); writeFileSync(config, original, { mode: 0o600 });
  const options = { client, config, manifest: join(p, "bin/.task-checkpoint-record/versions", installed.version_id, "manifest.json"), state: join(p, "state"), profile: join(p, "profile") };
  return { p, original, config, artifact, options };
}
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function cliEffect(command: "apply" | "rollback", value: unknown, p: string, output: string) {
  const input = join(p, `${command}-reviewed-${Math.random().toString(16).slice(2)}.json`), bytes = JSON.stringify(value) + "\n";
  writeFileSync(input, bytes, { mode: 0o600 });
  return spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("../scripts/hook-plan.ts", import.meta.url)), command, command === "apply" ? "--plan" : "--receipt", input, "--sha256", sha(bytes), "--output", output], { encoding: "utf8", timeout: 10000 });
}

describe("native additive hook plans", () => {
  test("Codex plans append seven exact definitions and preserve foreign settings/positions", () => {
    const s = setup(), plan = createHookPlan(s.options); expect(readFileSync(s.config, "utf8")).toBe(s.original);
    const changed = JSON.parse(Buffer.from(plan.after.bytes!, "base64").toString()), old = JSON.parse(s.original);
    expect(changed.permissions).toEqual(old.permissions); expect(changed.unrelated).toEqual(old.unrelated); expect(changed.hooks.PreToolUse).toEqual(old.hooks.PreToolUse);
    expect(changed.hooks.Stop[0]).toEqual(old.hooks.Stop[0]); expect(changed.hooks.SessionStart[0]).toEqual(old.hooks.SessionStart[0]);
    expect(plan.additions.map(a => a.event)).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Interrupt", "SessionEnd", "Stop"]);
    for (const a of plan.additions) { expect(a.group.hooks[0].async).toBe(false); expect(a.group.hooks[0].command).toContain(plan.artifact_version); expect(a.group.hooks[0].command).toContain("'--profile'"); expect(a.group.hooks[0].command).toContain("'--no-env-file'"); expect(a.definition_sha256).toHaveLength(64); }
    expect(plan.additions.find(a => a.event === "Interrupt")!.group.hooks[0].timeout).toBe(1);
    expect(plan.native_trust.activated).toBe(false); expect(plan.policy.stop).toBe("advisory_only");
  });
  test("apply verifies bytes, repeat is idempotent, rollback restores original bytes", () => {
    const s = setup(), plan = createHookPlan(s.options), receipt = applyHookPlan(plan);
    expect(verifyHookPlan(plan).definitions_verified).toBe(true); expect(verifyHookPlan(plan).native_activation_verified).toBe(false);
    expect(applyHookPlan(plan).disposition).toBe("already_applied");
    const again = createHookPlan(s.options); expect(again.after).toEqual(again.before); expect(again.additions.every(a => a.disposition === "already_present")).toBe(true);
    expect(rollbackHooks(receipt).exact_original_bytes_restored).toBe(true); expect(readFileSync(s.config, "utf8")).toBe(s.original);
  });
  test("apply and rollback preflight unsafe receipt parents before native definition changes", () => {
    for (const command of ["apply", "rollback"] as const) {
      const s = setup(), plan = createHookPlan(s.options), input = command === "apply" ? plan : applyHookPlan(plan), expected = readFileSync(s.config);
      const parent = join(s.p, "unsafe-output"); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o777);
      const result = cliEffect(command, input, s.p, join(parent, "receipt.json"));
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error).toBe("directory_not_owned_or_writable_by_others");
      expect(readFileSync(s.config)).toEqual(expected); expect(readdirSync(parent)).toEqual([]);
    }
  });
  test("existing receipts, symlinked parents and target-overlapping outputs remain unchanged", () => {
    const s = setup(), plan = createHookPlan(s.options), parent = join(s.p, "receipts"); mkdirSync(parent, { mode: 0o700 });
    const existing = join(parent, "old.json"); writeFileSync(existing, "OLD_RECEIPT", { mode: 0o600 });
    const alias = join(s.p, "receipt-alias"); symlinkSync(parent, alias);
    for (const output of [existing, join(alias, "new.json"), join(s.p, "missing/new.json"), s.config]) {
      expect(cliEffect("apply", plan, s.p, output).status).toBe(1); expect(readFileSync(s.config, "utf8")).toBe(s.original);
    }
    const missingConfig = join(s.p, "profile/new-hooks.json"), missingPlan = createHookPlan({ ...s.options, config: missingConfig });
    const blocked = cliEffect("apply", missingPlan, s.p, missingConfig); expect(JSON.parse(blocked.stdout).error).toBe("receipt_overlaps_effect_target"); expect(existsSync(missingConfig)).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("OLD_RECEIPT"); expect(readdirSync(parent)).toEqual(["old.json"]);
  });
  test("CLI publication keeps compatible receipts and a durable pre-effect journal", () => {
    const s = setup(), plan = createHookPlan(s.options), output = join(s.p, "receipt.json");
    expect(cliEffect("apply", plan, s.p, output).status).toBe(0);
    const journal = join(s.p, readdirSync(s.p).find(name => name.startsWith(".receipt.json.recovery-"))!);
    const lines = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].phase).toBe("prepared_not_completion"); expect(lines[0].input.value).toEqual(plan);
    expect(lines[1].result).toEqual(JSON.parse(readFileSync(output, "utf8"))); expect(lines[1].result.native_activation_verified).toBe(false);
    expect(cliEffect("rollback", lines[1].result, s.p, join(s.p, "rollback.json")).status).toBe(0);
    expect(readFileSync(s.config, "utf8")).toBe(s.original);
  });
  test("late hook receipt publication failure retains a durable result that restores exact config bytes", () => {
    const s = setup(), plan = createHookPlan(s.options), parent = join(s.p, "receipts"); mkdirSync(parent, { mode: 0o700 });
    const input = join(s.p, "reviewed-plan.json"), bytes = JSON.stringify(plan); writeFileSync(input, bytes, { mode: 0o600 });
    let failure: ReceiptOperationError | undefined;
    try { withReceipt(join(parent, "receipt.json"), { operation: "hooks_apply", path: input, sha256: sha(bytes), value: plan }, () => { const result = applyHookPlan(plan); chmodSync(parent, 0o777); return result; }); }
    catch (error) { expect(error).toBeInstanceOf(ReceiptOperationError); failure = error as ReceiptOperationError; }
    expect(failure?.code).toBe("receipt_publication_failed"); expect(failure?.recovery.result_journaled).toBe(true);
    chmodSync(parent, 0o700);
    const result = JSON.parse(readFileSync(failure!.recovery.journal, "utf8").trim().split("\n")[1]).result;
    expect(result).toEqual(failure!.effect_result); expect(result.native_activation_verified).toBe(false);
    expect(rollbackHooks(result).exact_original_bytes_restored).toBe(true); expect(readFileSync(s.config, "utf8")).toBe(s.original);
  });
  test("Claude has no invented Interrupt event or unsupported context return", () => {
    const s = setup("claude"), plan = createHookPlan(s.options); expect(plan.additions).toHaveLength(6);
    expect(plan.additions.some(a => a.event === "Interrupt")).toBe(false); expect(plan.policy.cached_context_events).toEqual(["SessionStart", "UserPromptSubmit"]);
    expect(JSON.stringify(plan.additions)).not.toContain("continue");
  });
  test("concurrent edits block apply and rollback, preserving the edited config", () => {
    const s = setup(), plan = createHookPlan(s.options); writeFileSync(s.config, "{\"human_edit\":true}\n");
    expect(() => applyHookPlan(plan)).toThrow("precondition_changed"); expect(readFileSync(s.config, "utf8")).toContain("human_edit");
    const s2 = setup(), plan2 = createHookPlan(s2.options), receipt = applyHookPlan(plan2); writeFileSync(s2.config, "{\"later_edit\":true}\n");
    expect(() => rollbackHooks(receipt)).toThrow("precondition_changed"); expect(readFileSync(s2.config, "utf8")).toContain("later_edit");
  });
  test("symlink/hardlink configs and mutated planned effects are rejected", () => {
    const s = setup(); symlinkSync(s.config, join(s.p, "alias.json"));
    expect(() => createHookPlan({ ...s.options, config: join(s.p, "alias.json") })).toThrow("symlink_denied");
    const s2 = setup(); linkSync(s2.config, join(s2.p, "alias.json")); expect(() => createHookPlan(s2.options)).toThrow("nonregular_aliased_or_large_file");
    const s3 = setup(), plan = createHookPlan(s3.options); plan.after.bytes = Buffer.from('{"hooks":{}}').toString("base64");
    expect(() => applyHookPlan(plan)).toThrow("hook_plan_effects_changed"); expect(readFileSync(s3.config, "utf8")).toBe(s3.original);
  });
  test("altered same-command handlers conflict; unsupported events are not silently invented", () => {
    const cmd = "'/reviewed/path' 'hook'";
    const one = mergeHooks(Buffer.from("{}"), "codex", cmd); const changed = JSON.parse(one.bytes.toString()); changed.hooks.Stop[0].hooks[0].timeout = 100;
    expect(() => mergeHooks(Buffer.from(JSON.stringify(changed)), "codex", cmd)).toThrow("conflicting_existing_definition");
    expect(() => mergeHooks(Buffer.from("{}"), "pi" as any, cmd)).toThrow("unsupported_client");
    expect(() => mergeHooks(Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "'/bin/bun' '/prefix/.task-checkpoint-record/versions/old/record/cli.mjs' hook" }] }] } })), "codex", cmd)).toThrow("previous_version_requires_owned_rollback");
  });
  test("duplicate JSON members cannot silently discard another owner's settings", () => {
    expect(() => mergeHooks(Buffer.from('{"hooks":{"Stop":[]},"hooks":{"SessionStart":[]}}'), "codex", "'hook'")).toThrow("duplicate_config_key");
    expect(() => mergeHooks(Buffer.from('{"unrelated":{"x":1,"\\u0078":2}}'), "codex", "'hook'")).toThrow("duplicate_config_key");
  });
  test("plan may create an explicitly missing JSON file and rollback removes only that file", () => {
    const s = setup(), config = join(s.p, "profile/new-hooks.json"), plan = createHookPlan({ ...s.options, config });
    expect(existsSync(config)).toBe(false); const receipt = applyHookPlan(plan); expect(existsSync(config)).toBe(true);
    rollbackHooks(receipt); expect(existsSync(config)).toBe(false); expect(readFileSync(s.config, "utf8")).toBe(s.original);
  });
  test("unreviewed source-stage manifests and unsafe state directories are rejected", () => {
    const s = setup(); expect(() => createHookPlan({ ...s.options, manifest: join(s.p, "stage/manifest.json") })).toThrow("immutable_installed_artifact_required");
    symlinkSync(s.options.state, join(s.p, "state-alias")); expect(() => createHookPlan({ ...s.options, state: join(s.p, "state-alias") })).toThrow("symlink_denied");
  });
});

describe("versioned Pi adapter template", () => {
  test("registration has no admission/start effects; callbacks omit bodies and native turn guesses", async () => {
    const callbacks = new Map<string, Function>(), admitted: any[] = []; let removed = 0;
    const dispose = registerTaskCheckpointRecord({ on: (name, fn) => { callbacks.set(name, fn); return () => { removed++; }; } }, { role: "master", admit: async e => { admitted.push(e); } });
    expect(admitted).toHaveLength(0); expect([...callbacks.keys()]).toEqual(["session_start", "session_shutdown", "session_before_compact", "session_compact", "turn_end"]);
    const output = await callbacks.get("turn_end")!({ turnIndex: 9, messageEntryId: "entry1", toolResultEntryIds: ["tool1"], outcome: "completed", message: "PRIVATE", toolResults: ["PRIVATE"] }, { cwd: "/test", sessionManager: { getSessionId: () => "native-pi-session", getSessionFile: () => undefined } });
    expect(output).toBeUndefined(); expect(admitted[0].adapter.native_turn_id).toBeNull(); expect(admitted[0].transcript_path).toBeNull(); expect(JSON.stringify(admitted)).not.toContain("PRIVATE"); expect(JSON.stringify(admitted)).not.toContain("turnIndex");
    dispose(); dispose(); expect(removed).toBe(5);
  });
  test("worker role is inert and an admission failure cannot request continuation", async () => {
    let registrations = 0; registerTaskCheckpointRecord({ on: () => { registrations++; return () => {}; } }, { role: "worker", admit: async () => { throw new Error("must not execute"); } }); expect(registrations).toBe(0);
    const callbacks = new Map<string, Function>(), drops: string[] = [];
    registerTaskCheckpointRecord({ on: (name, fn) => { callbacks.set(name, fn); return () => {}; } }, { role: "master", admit: async () => { throw new Error("failed"); }, onDrop: code => drops.push(code) });
    expect(await callbacks.get("session_shutdown")!({ reason: "reload" }, { cwd: "/test", sessionManager: { getSessionId: () => "session", getSessionFile: () => "/planned/not-proven.jsonl" } })).toBeUndefined(); expect(drops).toEqual(["admission_failed"]);
  });
  test("admission deadline aborts the sink and returns without controlling the Pi turn", async () => {
    const callbacks = new Map<string, Function>(), drops: string[] = []; let aborted = false;
    registerTaskCheckpointRecord({ on: (name, fn) => { callbacks.set(name, fn); return () => {}; } }, { role: "master", timeoutMs: 10,
      admit: async (_event, signal) => { signal.addEventListener("abort", () => { aborted = true; }); await new Promise<void>(() => {}); }, onDrop: code => drops.push(code) });
    const result = await callbacks.get("session_start")!({ reason: "startup" }, { cwd: "/test", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined } });
    expect(result).toBeUndefined(); expect(aborted).toBe(true); expect(drops).toEqual(["admission_timeout"]);
  });
});

#!/usr/bin/env node
/** Real Pi loader/runner and local package management; synthetic events, no model. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--package-root", "--sdk-root", "--work"]) assert(args.has(key), key + " required");
assert.equal(args.size, 3);
const pkg = resolve(args.get("--package-root")), sdk = resolve(args.get("--sdk-root")), work = resolve(args.get("--work"));
const sdkPackage = JSON.parse(await readFile(join(sdk, "package.json"), "utf8"));
assert.equal(sdkPackage.name, "@earendil-works/pi-coding-agent"); assert.equal(sdkPackage.version, "0.87.1");
const inventoryBytes = await readFile(join(pkg, "pi-package.json"));
const inventory = JSON.parse(inventoryBytes);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
for (const item of inventory.files) {
  const path = join(pkg, item.path), bytes = await readFile(path), info = await stat(path);
  assert.equal(digest(bytes), item.sha256); assert.equal(bytes.length, item.size); assert.equal(info.mode & 0o777, item.mode);
}
await mkdir(work, { mode: 0o700 });
for (const name of ["profile", "inputs", "tmp", "cache"]) await mkdir(join(work, name), { mode: 0o700 });
const profile = join(work, "profile"), source = join(work, "inputs", "synthetic.jsonl"), state = join(work, "state");
process.env.PI_CODING_AGENT_DIR = profile; process.env.PI_OFFLINE = "1";
process.env.TMPDIR = join(work, "tmp"); process.env.XDG_CACHE_HOME = join(work, "cache");
process.env.JITI_FS_CACHE = "0";
for (const name of ["BUN_OPTIONS", "NODE_OPTIONS", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[name];
const cli = join(pkg, "scripts/cli.mjs");
const commands = [];
function run(command, argv, json = true) {
  const result = spawnSync(command, argv, { cwd: work, env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  commands.push({ argv: [command, ...argv], exit_code: result.status, stdout_sha256: digest(result.stdout ?? ""), stderr_sha256: digest(result.stderr ?? "") });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return json ? JSON.parse(result.stdout) : result.stdout;
}
const info = run(process.execPath, [cli, "--package-info"]);
const rows = [
  { type: "session", version: 3, id: "pi-synthetic-host-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: work },
  { type: "message", id: "aa000001", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "synthetic local fixture", timestamp: 1 } },
  { type: "message", id: "aa000002", parentId: "aa000001", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "synthetic response" }], api: "synthetic", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } }
];
const sourceBytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n"; await writeFile(source, sourceBytes);
const config = join(work, "task-checkpoint.json");
const configBytes = JSON.stringify({ schema_version: "task-checkpoint.config.v1", recorder: { state_dir: state, helper_command: info.helper_command } });
await writeFile(config, configBytes, { mode: 0o600 });
const binding = { schema_version: "task-checkpoint-record.binding.v1", binding_id: "pi-host-binding", task_id: "pi-host-task", project_id: null,
  client: "pi", profile: "isolated-pi", runtime_home: null, role: "master", native_session_id: rows[0].id,
  source_root: dirname(source), sources: [{ source_id: "pi-host-source", path: source, format: "pi", start_at: "beginning" }] };
const bindingFile = join(work, "binding.json"); await writeFile(bindingFile, JSON.stringify(binding));
run(process.execPath, [cli, "init", "--config", config]); run(process.execPath, [cli, "bind", "--config", config, "--file", bindingFile]);

// The native package CLI uses an isolated profile and a local source, never npm.
const piCli = join(sdk, "dist/bundle/cli.js");
run(process.execPath, [piCli, "install", pkg], false);
const listing = run(process.execPath, [piCli, "list"], false); assert(listing.includes(pkg));
const installed = JSON.parse(await readFile(join(profile, "settings.json"), "utf8"));
assert(JSON.stringify(installed.packages).includes(pkg));

const { discoverAndLoadExtensions } = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")).href);
const { ExtensionRunner } = await import(pathToFileURL(join(sdk, "dist/core/extensions/runner.js")).href);
const { SessionManager } = await import(pathToFileURL(join(sdk, "dist/core/session-manager.js")).href);
const loaded = await discoverAndLoadExtensions([pkg], work, profile);
assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
assert.equal(run(process.execPath, [cli, "query", "--config", config, "--kind", "events"]).items.length, 0);
process.env.TCR_PLUGIN_ENABLED = "1"; process.env.TCR_CONFIG = config;
process.env.TCR_CONFIG_SHA256 = digest(configBytes); process.env.TCR_PROFILE = "isolated-pi";
const sessionManager = SessionManager.open(source);
assert.equal(sessionManager.getSessionId(), rows[0].id); assert.equal(sessionManager.getSessionFile(), source);
const unavailableModels = new Proxy({}, { get() { throw new Error("model registry must remain unused"); } });
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, work, sessionManager, unavailableModels);
const errors = []; runner.onError(error => errors.push(error));
await runner.emit({ type: "session_start", reason: "startup" });
const compact = await runner.emit({ type: "session_before_compact", reason: "manual", willRetry: false, preparation: {}, branchEntries: [], signal: new AbortController().signal });
assert(!compact?.cancel && !compact?.compaction);
await runner.emit({ type: "session_compact", reason: "manual", willRetry: false, compactionEntry: { id: "aa000003" }, fromExtension: false });
const boundary = await runner.emitBoundary({ type: "turn_end", turnIndex: 0, outcome: "completed", message: rows[2].message,
  toolResults: [], messageEntryId: "aa000002", toolResultEntryIds: [] }, () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }));
assert.equal(boundary.continue, false); assert.deepEqual(boundary.entries, []); assert.equal(boundary.valid, true);
await runner.emit({ type: "session_shutdown", reason: "quit" }); assert.deepEqual(errors, []);
const events = run(process.execPath, [cli, "query", "--config", config, "--kind", "events"]);
assert.equal(events.items.length, 5); assert(events.items.every(row => row.native_turn_id === null));
const drain = run(process.execPath, [cli, "service", "once", "--config", config]); assert.equal(drain.outcomes.succeeded, 5);
const records = run(process.execPath, [cli, "query", "--config", config, "--kind", "records"]); assert.equal(records.items.length, 3);
const entry = records.items.find(row => row.native.entry_id === "aa000002"); assert(entry);
assert.equal(entry.native.parent_entry_id, "aa000001"); assert.equal(entry.native.turn_id, null);
const resolved = run(process.execPath, [cli, "resolve", "--config", config, "--link", entry.deeplink]);
assert(JSON.stringify(resolved).includes("aa000002")); assert.equal(await readFile(source, "utf8"), sourceBytes);
run(process.execPath, [piCli, "remove", pkg], false);
const remaining = JSON.parse(await readFile(join(profile, "settings.json"), "utf8"));
assert(!JSON.stringify(remaining.packages ?? []).includes(pkg)); await stat(join(state, "store.sqlite")); await stat(config);
for (const item of inventory.files) assert.equal(digest(await readFile(join(pkg, item.path))), item.sha256);
const receipt = { schema_version: "task-checkpoint.pi-host-smoke.v1", status: "pass", pi_version: sdkPackage.version,
  package_inventory_sha256: digest(inventoryBytes), source_core_commit: inventory.components.recorder.source.commit,
  source_helper_commit: inventory.components.helper.source.commit, actual_pi_loader_runner: true,
  actual_local_install_list_remove: true, synthetic_emitted_callbacks: 5, durable_events: events.items.length,
  extracted_records: records.items.length, verified_entry_id: entry.native.entry_id, native_turn_ids: "unavailable",
  source_unchanged: true, user_state_retained_after_remove: true, model_calls: 0, account_operations: 0,
  npm_publish: false, global_pi_profile_used: false, commands };
await writeFile(join(work, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(receipt) + "\n");

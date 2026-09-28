import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { OWNER, ReceiptOperationError, applyPlan, artifactCommand, checkedJSON, fileHash, planBuiltArtifacts, prepareBundlePlan, preparePlan, rollbackInstall, sha, verifyInstall, verifyReleaseBundle, withReceipt, type Manifest, type ReleaseBundle } from "../scripts/install-cli.ts";

const roots: string[] = [];
const recordSource = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const helperSource = process.env.TCR_HELPER_SOURCE ?? join(dirname(recordSource), "ultrafast-atif-helper");
function root() { const p = realpathSync(mkdtempSync(join(tmpdir(), "tcr-install-"))); roots.push(p); return p; }
function fixture(p = root(), marker = "one", stageName = "stage") {
  const prefix = join(p, "bin"); if (!existsSync(prefix)) mkdirSync(prefix, { mode: 0o700 });
  const stage = join(p, stageName); mkdirSync(stage, { mode: 0o700 }); mkdirSync(join(stage, "record"), { mode: 0o700 });
  const runtimePath = join(p, "runtime"); if (!existsSync(runtimePath)) writeFileSync(runtimePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const artifact = join(stage, "record/cli.mjs"); writeFileSync(artifact, `// fixture ${marker}\n`, { mode: 0o600 });
  const runtime = { path: runtimePath, sha256: fileHash(runtimePath), version: "fixture-only" };
  const manifest: Manifest = { schema_version: "task-checkpoint-record.install-manifest.v1", owner: OWNER, sources: [], runtimes: { bun: runtime, node: runtime },
    files: [{ path: "record/cli.mjs", sha256: fileHash(artifact), mode: 0o600 }], help_checks: [] };
  return { p, prefix, stage, manifest, runtimePath, artifact };
}
function bundleFixture(realSources = false) {
  const p = root(), bundleRoot = join(p, "bundle"), prefix = join(p, "bin");
  mkdirSync(bundleRoot, { mode: 0o700 }); mkdirSync(prefix, { mode: 0o700 });
  const helper = join(bundleRoot, "vendor/ultrafast-atif-helper"); mkdirSync(helper, { recursive: true, mode: 0o700 });
  const license = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n";
  function copyTree(from: string, to: string) {
    if (lstatSync(from).isDirectory()) { mkdirSync(to, { recursive: true, mode: 0o700 }); for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name)); }
    else { const mode = lstatSync(from).mode & 0o111 ? 0o755 : 0o644; writeFileSync(to, readFileSync(from), { mode }); chmodSync(to, mode); }
  }
  for (const [from, to, name, version] of [[recordSource, bundleRoot, "task-checkpoint-record", "0.1.0"], [helperSource, helper, "ultrafast-atif-helper", "0.2.0"]]) {
    if (realSources) for (const path of ["package.json", "tsconfig.json", "LICENSE", "src", "bin"]) copyTree(join(from, path), join(to, path));
    else { writeFileSync(join(to, "LICENSE"), license, { mode: 0o644 }); writeFileSync(join(to, "package.json"), JSON.stringify({ name, version }), { mode: 0o644 }); }
  }
  const component = (kind: "recorder" | "helper"): ReleaseBundle["recorder"] => {
    const name = kind === "recorder" ? "task-checkpoint-record" : "ultrafast-atif-helper", subroot = kind === "recorder" ? "." : "vendor/ultrafast-atif-helper";
    const files: ReleaseBundle["recorder"]["files"] = [];
    const walk = (path: string) => { for (const part of readdirSync(join(bundleRoot, path)).sort()) { const rel = path === "." ? part : `${path}/${part}`;
      if (kind === "recorder" && rel === "vendor") continue; const full = join(bundleRoot, rel), s = lstatSync(full);
      if (s.isDirectory()) walk(rel); else files.push({ path: rel, sha256: fileHash(full), size: s.size, mode: s.mode & 0o777 }); } };
    walk(subroot); const licensePath = kind === "recorder" ? "LICENSE" : `${subroot}/LICENSE`;
    return { name, root: subroot, version: JSON.parse(readFileSync(join(bundleRoot, subroot, "package.json"), "utf8")).version,
      source: { repository: `https://github.com/lwyBZss8924d/${name}`, commit: (kind === "recorder" ? "1" : "2").repeat(40) },
      license: { spdx: "MIT", path: licensePath, sha256: fileHash(join(bundleRoot, licensePath)) }, files };
  };
  const release: ReleaseBundle = { schema_version: "task-checkpoint-record.release-bundle.v1", recorder: component("recorder"), helper: component("helper"),
    compatibility: { helper_page_schema: "ultrafast-atif.page.v1", recorder_help_schema: "task-checkpoint-record.help.v1" } };
  const manifest = join(bundleRoot, "release-bundle.json"), save = () => { const data = JSON.stringify(release) + "\n"; writeFileSync(manifest, data, { mode: 0o644 }); return sha(data); };
  return { p, prefix, bundleRoot, helper, release, manifest, save, digest: save() };
}
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { force: true, recursive: true }); });
function cliEffect(command: "apply" | "rollback", value: unknown, p: string, output: string) {
  const input = join(p, `${command}-reviewed-${Math.random().toString(16).slice(2)}.json`), bytes = JSON.stringify(value) + "\n";
  writeFileSync(input, bytes, { mode: 0o600 });
  return spawnSync(process.execPath, ["--no-env-file", join(recordSource, "scripts/install-cli.ts"), command, command === "apply" ? "--plan" : "--receipt", input, "--sha256", sha(bytes), "--output", output], { encoding: "utf8", timeout: 10000 });
}
function dotenvFixture(p: string) {
  const cwd = join(p, "synthetic-dotenv"), implicitState = join(p, "dotenv-selected-state"); mkdirSync(cwd, { mode: 0o700 });
  writeFileSync(join(cwd, ".env"), `TASK_CHECKPOINT_RECORD_STATE=${implicitState}\nTCR_SYNTHETIC_DOTENV_MARKER=synthetic-only\n`, { mode: 0o600 });
  const env = { PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`, LANG: "C.UTF-8" };
  // This positive control deliberately reads only the synthetic file above.
  // It distinguishes actual dotenv suppression from a test with no loadable file.
  const control = spawnSync(process.execPath, ["-e", 'process.stdout.write(process.env.TCR_SYNTHETIC_DOTENV_MARKER ?? "missing")'], { cwd, env, encoding: "utf8" });
  expect(control.status).toBe(0); expect(control.stdout).toBe("synthetic-only");
  return { cwd, implicitState, env };
}

describe("owned immutable CLI installation", () => {
  test("source executable ignores cwd dotenv while explicit state remains usable", () => {
    const p = root(), f = dotenvFixture(p), executable = join(recordSource, "bin/task-checkpoint-record");
    const ignored = spawnSync(executable, ["init"], { cwd: f.cwd, env: f.env, encoding: "utf8" });
    expect(ignored.status).toBe(1); expect(JSON.parse(ignored.stderr).error).toBe("state_required"); expect(existsSync(f.implicitState)).toBe(false);
    const explicitState = join(p, "explicit-state"), explicit = spawnSync(executable, ["init", "--state", explicitState], { cwd: f.cwd, env: f.env, encoding: "utf8" });
    expect(explicit.status).toBe(0); expect(JSON.parse(explicit.stdout).schema_version).toBe("task-checkpoint-record.status.v1");
    expect(existsSync(join(explicitState, "store.sqlite"))).toBe(true); expect(existsSync(f.implicitState)).toBe(false);
  });
  test("plan is noninstalling; apply, idempotence, verification and exact rollback", () => {
    const f = fixture(), p = planBuiltArtifacts(f.stage, f.prefix, f.manifest);
    expect(existsSync(join(f.prefix, "task-checkpoint-record"))).toBe(false);
    const receipt = applyPlan(p); expect(receipt.disposition).toBe("applied");
    expect(verifyInstall(f.prefix).verified).toBe(true); expect(applyPlan(p).disposition).toBe("already_applied");
    const launcher = readFileSync(join(f.prefix, "task-checkpoint-record"), "utf8"); expect(launcher).toContain(p.version_id);
    expect(launcher).toContain("'--no-env-file'"); expect(artifactCommand(join(f.prefix, ".task-checkpoint-record/versions", p.version_id, "manifest.json"), "task-checkpoint-record")[1]).toBe("--no-env-file");
    expect(rollbackInstall(receipt).restored).toBe(true); expect(existsSync(join(f.prefix, "task-checkpoint-record"))).toBe(false);
    expect(existsSync(join(f.prefix, ".task-checkpoint-record/versions", p.version_id, "manifest.json"))).toBe(true);
  });
  test("foreign command is never overwritten", () => {
    const f = fixture(); writeFileSync(join(f.prefix, "task-checkpoint-record"), "foreign\n", { mode: 0o755 });
    expect(() => planBuiltArtifacts(f.stage, f.prefix, f.manifest)).toThrow("foreign_or_modified_command");
    expect(readFileSync(join(f.prefix, "task-checkpoint-record"), "utf8")).toBe("foreign\n");
  });
  test("new foreign command after planning causes no partial installation", () => {
    const f = fixture(), p = planBuiltArtifacts(f.stage, f.prefix, f.manifest);
    writeFileSync(join(f.prefix, "ultrafast-atif-helper"), "foreign", { mode: 0o700 });
    expect(() => applyPlan(p)).toThrow("foreign_or_modified_command"); expect(existsSync(join(f.prefix, "task-checkpoint-record"))).toBe(false);
  });
  test("modified owned command and foreign hardlink block verification and rollback", () => {
    const f = fixture(), p = planBuiltArtifacts(f.stage, f.prefix, f.manifest), receipt = applyPlan(p);
    writeFileSync(join(f.prefix, "task-checkpoint-record"), "modified");
    expect(() => verifyInstall(f.prefix)).toThrow("foreign_or_modified_command"); expect(() => rollbackInstall(receipt)).toThrow();
    const f2 = fixture(); writeFileSync(join(f2.p, "foreign"), "foreign", { mode: 0o700 }); linkSync(join(f2.p, "foreign"), join(f2.prefix, "task-checkpoint-record"));
    expect(() => planBuiltArtifacts(f2.stage, f2.prefix, f2.manifest)).toThrow("nonregular_aliased_or_large_file");
  });
  test("symlink prefixes, escaped artifact names and tampered stages are rejected", () => {
    const f = fixture(); symlinkSync(f.prefix, join(f.p, "alias"));
    expect(() => planBuiltArtifacts(f.stage, join(f.p, "alias"), f.manifest)).toThrow("symlink_denied");
    const f2 = fixture(); f2.manifest.files[0].path = "../escape";
    expect(() => planBuiltArtifacts(f2.stage, f2.prefix, f2.manifest)).toThrow("invalid_artifact_path");
    const f3 = fixture(), p = planBuiltArtifacts(f3.stage, f3.prefix, f3.manifest); writeFileSync(f3.artifact, "tampered");
    expect(() => applyPlan(p)).toThrow("artifact_changed"); expect(existsSync(join(f3.prefix, "task-checkpoint-record"))).toBe(false);
  });
  test("runtime change and concurrent installer lock fail closed", () => {
    const f = fixture(), p = planBuiltArtifacts(f.stage, f.prefix, f.manifest); writeFileSync(f.runtimePath, "changed");
    expect(() => applyPlan(p)).toThrow("runtime_changed");
    const f2 = fixture(), p2 = planBuiltArtifacts(f2.stage, f2.prefix, f2.manifest);
    writeFileSync(join(f2.prefix, ".task-checkpoint-record.install.lock"), "another operation"); expect(() => applyPlan(p2)).toThrow();
    expect(readFileSync(join(f2.prefix, ".task-checkpoint-record.install.lock"), "utf8")).toBe("another operation");
  });
  test("upgrades use new immutable directories and rollback restores previous version", () => {
    const f = fixture(), first = planBuiltArtifacts(f.stage, f.prefix, f.manifest); applyPlan(first);
    const before = readFileSync(join(f.prefix, "task-checkpoint-record"));
    const second = fixture(f.p, "two", "stage-two"), plan = planBuiltArtifacts(second.stage, second.prefix, second.manifest), receipt = applyPlan(plan);
    expect(plan.version_id).not.toBe(first.version_id); expect(verifyInstall(f.prefix).version_id).toBe(plan.version_id);
    expect(rollbackInstall(receipt).restored).toBe(true); expect(verifyInstall(f.prefix).version_id).toBe(first.version_id);
    expect(readFileSync(join(f.prefix, "task-checkpoint-record"))).toEqual(before);
  });
  test("apply and rollback reject unsafe receipt parents before changing targets", () => {
    for (const command of ["apply", "rollback"] as const) {
      const f = fixture(), plan = planBuiltArtifacts(f.stage, f.prefix, f.manifest), input = command === "apply" ? plan : applyPlan(plan);
      const expected = command === "rollback" ? readFileSync(join(f.prefix, "task-checkpoint-record")) : null;
      const parent = join(f.p, "unsafe-output"); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o777);
      const output = join(parent, "receipt.json"), result = cliEffect(command, input, f.p, output);
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error).toBe("directory_not_owned_or_writable_by_others");
      expect(readdirSync(parent)).toEqual([]);
      if (expected) { expect(readFileSync(join(f.prefix, "task-checkpoint-record"))).toEqual(expected); expect(verifyInstall(f.prefix).version_id).toBe(plan.version_id); }
      else { expect(existsSync(join(f.prefix, "task-checkpoint-record"))).toBe(false); expect(existsSync(join(f.prefix, ".task-checkpoint-record"))).toBe(false); }
    }
  });
  test("ineligible, existing and target-overlapping receipt paths are nonmutating", () => {
    const f = fixture(), plan = planBuiltArtifacts(f.stage, f.prefix, f.manifest), parent = join(f.p, "receipts"); mkdirSync(parent, { mode: 0o700 });
    const old = join(parent, "existing.json"); writeFileSync(old, "FOREIGN_RECEIPT", { mode: 0o600 });
    const alias = join(f.p, "alias"); symlinkSync(parent, alias);
    for (const output of [old, join(alias, "new.json"), join(f.p, "missing/new.json"), join(f.prefix, "task-checkpoint-record"), join(f.stage, "new-receipt.json")]) {
      expect(cliEffect("apply", plan, f.p, output).status).toBe(1); expect(existsSync(join(f.prefix, "task-checkpoint-record"))).toBe(false);
    }
    expect(readFileSync(old, "utf8")).toBe("FOREIGN_RECEIPT"); expect(readdirSync(parent)).toEqual(["existing.json"]);
  });
  test("successful CLI receipts retain a pre-effect recovery journal and preserve rollback compatibility", () => {
    const f = fixture(), plan = planBuiltArtifacts(f.stage, f.prefix, f.manifest), output = join(f.p, "receipt.json");
    const applied = cliEffect("apply", plan, f.p, output); expect(applied.status).toBe(0);
    const journal = join(f.p, readdirSync(f.p).find(x => x.startsWith(".receipt.json.recovery-"))!);
    const lines = readFileSync(journal, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(lines[0].phase).toBe("prepared_not_completion"); expect(lines[0].input.value).toEqual(plan);
    expect(lines[1].phase).toBe("effects_completed"); expect(lines[1].result).toEqual(JSON.parse(readFileSync(output, "utf8")));
    expect(lstatSync(journal).mode & 0o777).toBe(0o600); expect(lstatSync(output).mode & 0o777).toBe(0o600);
    const rolled = cliEffect("rollback", lines[1].result, f.p, join(f.p, "rollback.json")); expect(rolled.status).toBe(0); expect(JSON.parse(rolled.stdout).restored).toBe(true);
  });
  test("late receipt publication failure retains the full durable rollback result", () => {
    const f = fixture(), plan = planBuiltArtifacts(f.stage, f.prefix, f.manifest), parent = join(f.p, "receipts"); mkdirSync(parent, { mode: 0o700 });
    const inputPath = join(f.p, "reviewed-plan.json"), bytes = JSON.stringify(plan); writeFileSync(inputPath, bytes, { mode: 0o600 });
    let failure: ReceiptOperationError | undefined;
    try { withReceipt(join(parent, "receipt.json"), { operation: "apply", path: inputPath, sha256: sha(bytes), value: plan }, () => { const result = applyPlan(plan); chmodSync(parent, 0o777); return result; }); }
    catch (error) { expect(error).toBeInstanceOf(ReceiptOperationError); failure = error as ReceiptOperationError; }
    expect(failure?.code).toBe("receipt_publication_failed"); expect(failure?.recovery.result_journaled).toBe(true);
    chmodSync(parent, 0o700);
    const lines = readFileSync(failure!.recovery.journal, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(lines[1].result).toEqual(failure!.effect_result); expect(lines[1].result.disposition).toBe("applied");
    expect(JSON.parse(readFileSync(failure!.recovery.receipt, "utf8")).schema_version).toBe("task-checkpoint-record.receipt-pending.v1");
    expect(rollbackInstall(lines[1].result).restored).toBe(true);
  });
  test("a replaced receipt reservation is never overwritten and its journal still supports recovery", () => {
    const f = fixture(), plan = planBuiltArtifacts(f.stage, f.prefix, f.manifest), output = join(f.p, "receipt.json"), inputPath = join(f.p, "input.json"), inputBytes = JSON.stringify(plan);
    writeFileSync(inputPath, inputBytes, { mode: 0o600 }); let failure: ReceiptOperationError | undefined;
    try { withReceipt(output, { operation: "apply", path: inputPath, sha256: sha(inputBytes), value: plan }, () => { const result = applyPlan(plan); rmSync(output); writeFileSync(output, "ANOTHER_WRITER", { mode: 0o600 }); return result; }); }
    catch (error) { failure = error as ReceiptOperationError; }
    expect(failure?.code).toBe("receipt_publication_failed"); expect(readFileSync(output, "utf8")).toBe("ANOTHER_WRITER");
    const journal = readFileSync(failure!.recovery.journal, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(rollbackInstall(journal[1].result).restored).toBe(true);
  });
  test("changed retired runtime or artifact cannot corrupt the active version during rollback", () => {
    for (const mutation of ["runtime", "artifact"] as const) {
      const f = fixture(), v1 = planBuiltArtifacts(f.stage, f.prefix, f.manifest); applyPlan(v1);
      const f2 = fixture(f.p, "two", "stage-two"), runtime2 = join(f.p, "runtime-two"); writeFileSync(runtime2, "#!/bin/sh\nexit 0\n# separate runtime\n", { mode: 0o700 });
      f2.manifest.runtimes = { bun: { path: runtime2, sha256: fileHash(runtime2), version: "two" }, node: { path: runtime2, sha256: fileHash(runtime2), version: "two" } };
      const v2 = planBuiltArtifacts(f2.stage, f2.prefix, f2.manifest), receipt = applyPlan(v2);
      const target = mutation === "runtime" ? f.runtimePath : join(f.prefix, ".task-checkpoint-record/versions", v1.version_id, "record/cli.mjs"), original = readFileSync(target);
      writeFileSync(target, "CHANGED_RETIRED_DEPENDENCY"); expect(verifyInstall(f.prefix).version_id).toBe(v2.version_id);
      const names = ["task-checkpoint-record", "ultrafast-atif-helper", ".task-checkpoint-record/current.json"], beforeBytes = names.map(name => readFileSync(join(f.prefix, name)));
      expect(() => rollbackInstall(receipt)).toThrow(mutation === "runtime" ? "runtime_changed" : "artifact_changed");
      names.forEach((name, i) => expect(readFileSync(join(f.prefix, name))).toEqual(beforeBytes[i])); expect(verifyInstall(f.prefix).version_id).toBe(v2.version_id);
      writeFileSync(target, original); expect(rollbackInstall(receipt).restored).toBe(true); expect(verifyInstall(f.prefix).version_id).toBe(v1.version_id);
    }
  });
  test("reviewed input digest is mandatory and owner-like comments do not prove ownership", () => {
    const f = fixture(); const input = join(f.p, "plan.json"); writeFileSync(input, "{}");
    expect(() => checkedJSON(input, "0".repeat(64))).toThrow("reviewed_plan_changed");
    writeFileSync(join(f.prefix, "task-checkpoint-record"), `#!/bin/sh\n# Owned by ${OWNER}\n`, { mode: 0o755 });
    expect(() => planBuiltArtifacts(f.stage, f.prefix, f.manifest)).toThrow("foreign_or_modified_command");
  });
  test.skipIf(!existsSync(join(helperSource, "package.json")))("real source builds run help through both installed launchers in a temp prefix (requires helper checkout)", () => {
    const p = root(), prefix = join(p, "bin"); mkdirSync(prefix, { mode: 0o700 });
    const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }); expect(node.status).toBe(0);
    const plan = preparePlan({ recordRepo: recordSource, helperRepo: helperSource, prefix, stage: join(p, "build"), bun: realpathSync(process.execPath), node: realpathSync(node.stdout.trim()) });
    expect(plan.manifest.help_checks).toHaveLength(2); expect(existsSync(join(prefix, "task-checkpoint-record"))).toBe(false);
    applyPlan(plan);
    for (const name of ["task-checkpoint-record", "ultrafast-atif-helper"]) {
      const result = spawnSync(join(prefix, name), ["--help"], { encoding: "utf8", cwd: p, env: { PATH: "/usr/bin:/bin" } });
      expect(result.status).toBe(0); expect(JSON.parse(result.stdout).commands).toBeDefined();
    }
    const version = spawnSync(join(prefix, "ultrafast-atif-helper"), ["--version"], { encoding: "utf8", cwd: p });
    expect(version.status).toBe(0); expect(JSON.parse(version.stdout).package).toBe("ultrafast-atif-helper");
    const dotenv = dotenvFixture(p), command = artifactCommand(join(prefix, ".task-checkpoint-record/versions", plan.version_id, "manifest.json"), "task-checkpoint-record");
    for (const argv of [[join(prefix, "task-checkpoint-record")], command]) {
      const ignored = spawnSync(argv[0], [...argv.slice(1), "init"], { cwd: dotenv.cwd, env: dotenv.env, encoding: "utf8" });
      expect(ignored.status).toBe(1); expect(JSON.parse(ignored.stderr).error).toBe("state_required"); expect(existsSync(dotenv.implicitState)).toBe(false);
    }
  }, 60000);
  test("bundled inventory verifies exact commits, versions and license hashes", () => {
    const f = bundleFixture(); const checked = verifyReleaseBundle(f.bundleRoot, f.digest);
    expect(checked.helper.source.commit).toBe("2".repeat(40)); expect(checked.helper.license.spdx).toBe("MIT");
    expect(() => verifyReleaseBundle(f.bundleRoot, "0".repeat(64))).toThrow("reviewed_plan_changed");
    f.release.helper.source.commit = "main"; expect(() => verifyReleaseBundle(f.bundleRoot, f.save())).toThrow("invalid_release_component");
  });
  test("bundled helper modification, private extras and escaped inventory paths fail before build", () => {
    const f = bundleFixture(); writeFileSync(join(f.helper, "LICENSE"), "changed"); expect(() => verifyReleaseBundle(f.bundleRoot, f.digest)).toThrow("release_file_changed");
    const f2 = bundleFixture(); mkdirSync(join(f2.bundleRoot, ".git")); writeFileSync(join(f2.bundleRoot, ".git/notes"), "PRIVATE_POUW");
    expect(() => verifyReleaseBundle(f2.bundleRoot, f2.digest)).toThrow("private_or_dependency_bundle_path");
    const f3 = bundleFixture(); f3.release.helper.files[0].path = "vendor/ultrafast-atif-helper/../../outside";
    expect(() => verifyReleaseBundle(f3.bundleRoot, f3.save())).toThrow("invalid_bundle_path");
    const f4 = bundleFixture(); writeFileSync(join(f4.bundleRoot, "unexpected.txt"), "unexpected"); expect(() => verifyReleaseBundle(f4.bundleRoot, f4.digest)).toThrow("unexpected_release_file");
  });
  test("bundled profile rejects links, incompatible protocol, license mismatch and stage inside payload", () => {
    const f = bundleFixture(); linkSync(join(f.helper, "LICENSE"), join(f.p, "alias-license")); expect(() => verifyReleaseBundle(f.bundleRoot, f.digest)).toThrow("unsafe_release_file");
    const f2 = bundleFixture(); f2.release.compatibility.helper_page_schema = "future" as any; expect(() => verifyReleaseBundle(f2.bundleRoot, f2.save())).toThrow("unsupported_release_bundle");
    const f3 = bundleFixture(); f3.release.helper.license.sha256 = "0".repeat(64); expect(() => verifyReleaseBundle(f3.bundleRoot, f3.save())).toThrow("invalid_release_license");
    const f4 = bundleFixture(); expect(() => prepareBundlePlan({ bundleRoot: f4.bundleRoot, bundleSha256: f4.digest, prefix: f4.prefix, stage: join(f4.bundleRoot, "build"), bun: process.execPath, node: process.execPath })).toThrow("stage_inside_release_bundle");
  });
  test.skipIf(!existsSync(join(helperSource, "package.json")))("one unpacked combined source bundle installs both real CLIs with pinned helper/license metadata (synthetic release commits)", () => {
    const f = bundleFixture(true), node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }); expect(node.status).toBe(0);
    const planPath = join(f.p, "install-plan.json");
    const planned = spawnSync(process.execPath, ["--no-env-file", join(recordSource, "scripts/install-cli.ts"), "bundle-plan", "--bundle-root", f.bundleRoot, "--bundle-sha256", f.digest,
      "--prefix", f.prefix, "--stage", join(f.p, "build"), "--bun", realpathSync(process.execPath), "--node", realpathSync(node.stdout.trim()), "--output", planPath], { encoding: "utf8", timeout: 60000 });
    expect(planned.status).toBe(0); const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(JSON.parse(planned.stdout).sha256).toBe(fileHash(planPath));
    expect(plan.manifest.distribution!.release.helper).toEqual(f.release.helper); expect(plan.manifest.distribution!.manifest_sha256).toBe(f.digest);
    expect(plan.manifest.distribution!.installed_licenses.helper).toBe("licenses/ultrafast-atif-helper.LICENSE");
    applyPlan(plan); const checked = verifyInstall(f.prefix); expect(checked.verified).toBe(true);
    for (const name of ["task-checkpoint-record", "ultrafast-atif-helper"]) {
      const result = spawnSync(join(f.prefix, name), ["--help"], { encoding: "utf8", cwd: f.p, env: { PATH: "/usr/bin:/bin" } }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).commands).toBeDefined();
    }
    const installed = join(f.prefix, ".task-checkpoint-record/versions", plan.version_id);
    expect(fileHash(join(installed, "licenses/ultrafast-atif-helper.LICENSE"))).toBe(f.release.helper.license.sha256);
    expect(fileHash(join(installed, "release-bundle.json"))).toBe(f.digest);
  }, 60000);
});

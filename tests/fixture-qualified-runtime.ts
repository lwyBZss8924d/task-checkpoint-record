/** Synthetic local host attestation for fake-stdio integration only. No download, native Codex or model. */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { RuntimeSelection } from "../src/runtime-update.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function fixtureQualifiedRuntime(sourceExecutable: string, version = "0.999.0"): RuntimeSelection {
  const root = join(realpathSync(dirname(sourceExecutable)), "managed-fixture"), archive = "a".repeat(64);
  const directory = join(root, "versions", `${version}-${archive}`), pkg = join(directory, "package");
  for (const leaf of ["bin", "codex-resources", "codex-path"]) mkdirSync(join(pkg, leaf), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "owner.json"), JSON.stringify({ schema_version: "task-checkpoint.codex-runtime-owner.v1", owner: "task-checkpoint-record" }));
  const executable = join(pkg, "bin/codex"); copyFileSync(sourceExecutable, executable); chmodSync(executable, 0o700);
  writeFileSync(join(pkg, "bin/codex-code-mode-host"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const target = "aarch64-apple-darwin", platform = "darwin-arm64";
  writeFileSync(join(pkg, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version, target, variant: "codex", entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path" }));
  const files: { path: string; size: number; mode: number; sha256: string }[] = [];
  const visit = (dir: string) => { for (const leaf of readdirSync(dir).sort()) {
    const path = join(dir, leaf), stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else files.push({ path: relative(pkg, path), size: stat.size, mode: stat.mode & 0o777, sha256: hash(readFileSync(path)) });
  } };
  visit(pkg);
  const contractBytes = readFileSync(new URL("../container/app-server-surface.json", import.meta.url));
  const contract = JSON.parse(contractBytes.toString("utf8"));
  const observations = contract.schemas.map((schema: any) => ({ file: schema.file, type: "object", required: schema.required,
    checks: schema.checks.map((check: any) => ({ pointer: check.pointer, observed: check.equals })) }));
  const qualificationPath = join(directory, "qualification.json");
  writeFileSync(qualificationPath, JSON.stringify({ schema_version: "task-checkpoint.codex-qualification.v1", version,
    observed_version: `codex-cli ${version}`, package: "package", entrypoint: "bin/codex", authenticated_model_run: false,
    initialize: { method: "initialize", observed_version: version, initialized_notification_sent: true, threads_started: 0, turns_started: 0, process_exit_code: 0 },
    platform, archive_sha256: archive,
    release: { codex_version: version, codex_release: `https://github.com/openai/codex/releases/tag/rust-v${version}`,
      discovery: { url: "https://api.github.com/repos/openai/codex/releases/latest", draft: false, prerelease: false },
      codex_assets: { [platform]: { target, name: `codex-package-${target}.tar.gz`, sha256: archive } } },
    files, protocol: { contract_sha256: hash(contractBytes), version, result: "protocol_surface_pass", authenticated_model_run: false,
      schemas: observations.length, structural_checks: observations.reduce((n: number, schema: any) => n + schema.checks.length, 0), observations },
  }));
  return { executable, version, qualificationPath };
}

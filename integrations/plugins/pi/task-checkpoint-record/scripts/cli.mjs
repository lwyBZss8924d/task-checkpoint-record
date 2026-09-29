#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const recorder = join(root, "runtime/recorder/src/cli.ts");
const bunfig = join(root, "runtime/recorder/config/runtime.bunfig.toml");
if (process.argv[2] === "--package-info") {
  process.stdout.write(JSON.stringify({ schema_version: "task-checkpoint.pi-package-info.v1", package_root: root,
    recorder_command: ["node", fileURLToPath(import.meta.url)],
    helper_command: ["node", join(root, "runtime/helper/bin/ultrafast-atif-helper.mjs")],
    configuration: "explicit --config FILE; set recorder.helper_command to the contained helper_command above",
    effects: "none" }) + "\n");
} else {
  const environment = { ...process.env }; delete environment.BUN_OPTIONS; delete environment.NODE_OPTIONS;
  const child = spawn("bun", ["--no-env-file", "--no-install", "--config=" + bunfig, recorder, ...process.argv.slice(2)],
    { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" });
  child.on("error", () => { process.stderr.write('{"error":"pi_package_bun_unavailable"}\n'); process.exitCode = 1; });
  child.on("close", code => { process.exitCode = code ?? 1; });
}

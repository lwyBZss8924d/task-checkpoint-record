import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";

const root = resolve(import.meta.dir, "..");
const flags = ["--no-env-file", "--no-install", `--config=${join(root, "config/runtime.bunfig.toml")}`];
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function run(entry: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [...flags, entry, ...args], {
    cwd, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: tmpdir() },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("source CLI help agrees with package identity", () => {
  expect(run(join(root, "src/cli.ts"), ["--help"], root).version).toBe(version);
});

test.each(["release", "changed-before-build"])("compiled help and both initialize messages use the %s package version", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "recorder-version-")); directories.push(directory);
  const source = join(directory, "source"), output = join(directory, "output");
  await mkdir(source); await cp(join(root, "src"), join(source, "src"), { recursive: true });
  await mkdir(join(source, "container"));
  await cp(join(root, "container/app-server-surface.json"), join(source, "container/app-server-surface.json"));
  const expected = mode === "release" ? version : `${version}-identity-fixture`;
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(source, "package.json"), JSON.stringify({ ...packageJson, version: expected }));
  const driver = join(source, "initialize-only.ts");
  await writeFile(driver, `
import { runAppServerTask } from "./src/appserver.ts";
import { createAgentSession } from "./src/agent-runtime.ts";
const [executable, home, cwd] = process.argv.slice(2);
const common = { codexExecutable: executable, codexHome: home, cwd, limits: { deadlineMs: 2000, startupMs: 2000, shutdownMs: 50 } };
const outcomes = [];
for (const start of [
  () => runAppServerTask({ ...common, input: { dataClass: "synthetic", text: "initialize only" }, outputSchema: { type: "object" }, validateOutput: value => value }),
  () => createAgentSession({ ...common, tools: [{ name: "tcr_version_fixture", description: "Never executed", inputSchema: { type: "object", additionalProperties: false },
    validateArguments: () => { throw new Error("must not validate tool arguments"); }, execute: () => { throw new Error("must not execute tools"); } }] }),
]) {
  try { await start(); outcomes.push("unexpected_started_session"); }
  catch (error) { outcomes.push(error.code); }
}
console.log(JSON.stringify(outcomes));
`);
  const built = await Bun.build({ entrypoints: [join(source, "src/cli.ts"), driver], outdir: output, target: "bun", naming: "[name].mjs" });
  expect(built.success).toBe(true);
  // A changed package version must be embedded, not read from a source checkout at runtime.
  await rm(source, { recursive: true });
  const home = join(directory, "empty-codex-home"); await mkdir(home);
  const log = join(directory, "initialize.jsonl"), executable = join(directory, "fake-codex");
  await writeFile(executable, `#!${process.execPath}\n
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + "\\n");
  // Reject the synthetic runtime immediately after initialize: no account/model/thread request.
  process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "initialize-only-version-fixture" } }) + "\\n");
});
`, { mode: 0o700 });
  const help = run(join(output, "cli.mjs"), ["--help"], directory);
  const outcomes = run(join(output, "initialize-only.mjs"), [executable, home, directory], directory);
  const messages = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(outcomes).toEqual(["unsupported_codex_version", "unsupported_codex_version"]);
  expect(messages.map(message => message.method)).toEqual(["initialize", "initialize"]);
  expect(messages.map(message => message.params.clientInfo.name)).toEqual(["task_checkpoint_record", "task_checkpoint_record_agent"]);
  expect([help.version, ...messages.map(message => message.params.clientInfo.version)]).toEqual([expected, expected, expected]);
}, 20000);

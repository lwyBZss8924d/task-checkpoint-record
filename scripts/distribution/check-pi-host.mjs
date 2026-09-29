#!/usr/bin/env node
/** Check the adapter against actual host types and the exact selected Pi source API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--package-root", "--sdk-root", "--typescript-root", "--pi-source-root", "--work"]) assert(args.has(key), key + " required");
assert.equal(args.size, 5);
const pkg = resolve(args.get("--package-root")), sdk = resolve(args.get("--sdk-root")), compiler = resolve(args.get("--typescript-root"));
const source = resolve(args.get("--pi-source-root")), work = resolve(args.get("--work"));
const expected = "b485fa3128c3d8dae87cb59da6e95db0f991c5bc";
const revision = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
assert.equal(revision.status, 0); assert.equal(revision.stdout.trim(), expected);
assert.equal(JSON.parse(await readFile(join(sdk, "package.json"), "utf8")).version, "0.87.1");
const ts = (await import(pathToFileURL(join(compiler, "lib/typescript.js")).href)).default;
const sourceTypes = await readFile(join(source, "packages/coding-agent/src/core/extensions/types.ts"), "utf8");
const hostTypes = await readFile(join(sdk, "dist/core/extensions/types.d.ts"), "utf8");
const fields = { SessionStartEvent: ["type", "reason"], SessionBeforeCompactEvent: ["type", "reason"],
  SessionCompactEvent: ["type", "reason"], SessionShutdownEvent: ["type", "reason"],
  TurnEndEvent: ["type", "turnIndex", "messageEntryId", "toolResultEntryIds"], BoundaryState: ["outcome"] };
const printer = ts.createPrinter({ removeComments: true });
function contract(text) {
  const file = ts.createSourceFile("contract.ts", text, ts.ScriptTarget.Latest, true);
  const result = {};
  for (const declaration of file.statements) {
    const name = declaration.name?.getText(file);
    if (name in fields) {
      const values = {};
      for (const key of fields[name]) {
        const member = declaration.members.find(item => item.name?.getText(file) === key); assert(member?.type, name + "." + key);
        values[key] = { type: printer.printNode(ts.EmitHint.Unspecified, member.type, file).trim(), optional: !!member.questionToken };
      }
      result[name] = values;
    }
    if (name === "AgentActivityOutcome") result[name] = printer.printNode(ts.EmitHint.Unspecified, declaration.type, file).trim();
  }
  assert.equal(Object.keys(result).length, Object.keys(fields).length + 1); return result;
}
const observed = contract(hostTypes); assert.deepEqual(observed, contract(sourceTypes));
await mkdir(work, { mode: 0o700 });
const assertion = join(work, "factory-check.ts");
await writeFile(assertion, `import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";\nimport factory from ${JSON.stringify(join(pkg, "extensions/index.ts"))};\nconst checked: ExtensionFactory = factory;\nvoid checked;\n`);
const config = { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
  noEmit: true, allowImportingTsExtensions: true, resolveJsonModule: true, skipLibCheck: true,
  types: ["bun"], typeRoots: [join(compiler, "../@types")], baseUrl: work,
  paths: { "@earendil-works/pi-coding-agent": [join(sdk, "dist/index.d.ts")] } }, files: [assertion] };
const configPath = join(work, "tsconfig.json"); await writeFile(configPath, JSON.stringify(config, null, 2));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.BUN_OPTIONS;
const checked = spawnSync(process.execPath, [join(compiler, "bin/tsc"), "--project", configPath], { env: environment, encoding: "utf8", timeout: 30000 });
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
const sha = data => createHash("sha256").update(data).digest("hex");
const receipt = { schema_version: "task-checkpoint.pi-host-types.v1", status: "pass", pi_source_commit: expected,
  pi_host_version: "0.87.1", source_types_sha256: sha(sourceTypes), host_types_sha256: sha(hostTypes),
  selected_api: observed, extension_factory_assignment: "passed", model_or_auth_operations: false };
await writeFile(join(work, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(receipt) + "\n");

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runAppServerTask, type AppServerTaskOptions, type AppServerTaskResult } from "./appserver.ts";
import { ConfigurationError, type PortableConfig } from "./config.ts";
import { dedicatedConfigText, type ModelRole } from "./model-policy.ts";
import { childEnvironment, noSymlinks } from "./security.ts";

function fail(code: string): never { throw new ConfigurationError(code); }
function inside(root: string, target: string): boolean {
  const rel = relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function selectedPaths(config: PortableConfig): { home: string; executable: string };
function selectedPaths(config: PortableConfig, allowMissingExecutable: true): { home: string; executable: string | null };
function selectedPaths(config: PortableConfig, allowMissingExecutable = false): { home: string; executable: string | null } {
  const { home, executable } = config.codex;
  if (!home || (!executable && !allowMissingExecutable)) fail("config_codex_paths_required");
  for (const path of [home, ...(executable ? [executable] : [])]) if (!isAbsolute(path) || resolve(path) !== path) fail("config_codex_paths_absolute_required");
  try {
    if (executable) {
      noSymlinks(executable); accessSync(executable, constants.X_OK);
      const binary = lstatSync(executable);
      if (!binary.isFile()) fail("config_codex_executable_not_regular");
    }
    noSymlinks(dirname(home));
    if (existsSync(home)) noSymlinks(home);
    const userHome = realpathSync(homedir());
    const physical = existsSync(home) ? realpathSync(home) : join(realpathSync(dirname(home)), home.slice(dirname(home).length + 1));
    if (physical === userHome || physical === "/") fail("config_dedicated_home_required");
    for (const name of [".codex", ".codex-test", ".claude", ".pi"]) {
      const logical = join(userHome, name);
      const protectedHome = existsSync(logical) ? realpathSync(logical) : logical;
      if (inside(protectedHome, physical) || inside(physical, protectedHome)) fail("config_dedicated_home_required");
    }
    if (existsSync(home)) {
      const state = lstatSync(home);
      if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077)) fail("config_dedicated_home_not_private");
    }
  } catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_codex_path_unavailable"); }
  return { home, executable };
}
/** Latest-stable activation can precede first managed installation; authentication stays explicit. */
export function validateConfiguredAgentPaths(config: PortableConfig): void {
  if (config.agent_service.runtime_update.mode === "latest-stable") selectedPaths({ ...config, codex: { ...config.codex, executable: null } }, true);
  else selectedPaths(config);
}
export function configuredAppServerOptions(config: PortableConfig, role: ModelRole, cwd: string): Pick<AppServerTaskOptions<unknown>, "codexExecutable" | "codexHome" | "cwd" | "role" | "selection" | "qualificationPath"> {
  const { home, executable } = selectedPaths(config);
  if (!["supervisor", "semantic-worker", "eval"].includes(role)) fail("config_invalid_model_role");
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) fail("config_model_cwd_absolute_required");
  const selection = role === "semantic-worker" ? config.codex.semantic_worker : config.codex[role];
  return { codexExecutable: executable, codexHome: home, cwd, role, selection: { ...selection },
    ...(config.codex.qualification_receipt ? { qualificationPath: config.codex.qualification_receipt } : {}) };
}
export function runConfiguredAppServerTask<T>(config: PortableConfig,
  options: Omit<AppServerTaskOptions<T>, "codexExecutable" | "codexHome" | "selection">): Promise<AppServerTaskResult<T>> {
  return runAppServerTask({ ...options, ...configuredAppServerOptions(config, options.role ?? "supervisor", options.cwd) });
}
export function authPlan(config: PortableConfig): object & { plan_sha256: string; codex_home: string; config_text: string; home_exists: boolean } {
  const { home, executable } = selectedPaths(config);
  if (existsSync(home) && readdirSync(home).length) fail("config_auth_setup_requires_empty_home");
  const binary = lstatSync(executable);
  const configText = dedicatedConfigText(config.agent_service.execution_mode)
    .replace(/^model = .*$/mu, `model = ${JSON.stringify(config.codex.supervisor.model)}`)
    .replace(/^model_reasoning_effort = .*$/mu, `model_reasoning_effort = ${JSON.stringify(config.codex.supervisor.effort)}`);
  const plan = { schema_version: "task-checkpoint.auth-plan.v1", action: "create_new_dedicated_profile",
    codex_home: home, codex_executable: executable, home_exists: existsSync(home),
    executable_identity: { dev: binary.dev, ino: binary.ino, size: binary.size, mtime_ms: binary.mtimeMs },
    config_text: configText, credentials_copied: false, login_started: false };
  return { ...plan, plan_sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}
export function setupAuth(config: PortableConfig, planSha256: string): object {
  const plan = authPlan(config);
  if (!/^[a-f0-9]{64}$/u.test(planSha256) || plan.plan_sha256 !== planSha256) fail("config_auth_plan_changed");
  try {
    if (!plan.home_exists) mkdirSync(plan.codex_home, { mode: 0o700 });
    selectedPaths(config);
    if (readdirSync(plan.codex_home).length) fail("config_auth_setup_requires_empty_home");
    writeFileSync(join(plan.codex_home, "config.toml"), plan.config_text, { flag: "wx", mode: 0o600 });
  } catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_auth_setup_failed"); }
  return { schema_version: "task-checkpoint.auth-setup.v1", codex_home: plan.codex_home,
    plan_sha256: planSha256, config_created: true, credentials_copied: false, login_started: false };
}
/** Official CLI owns the terminal and credentials. This wrapper never captures device codes. */
export async function runAuth(config: PortableConfig, action: "login" | "status"): Promise<number> {
  if (action !== "login" && action !== "status") fail("config_invalid_auth_action");
  const { home, executable } = selectedPaths(config);
  try {
    const file = join(home, "config.toml"); noSymlinks(file); const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) fail("config_auth_profile_not_private");
  } catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_auth_profile_missing"); }
  const env = childEnvironment("observer"); env.CODEX_HOME = home;
  // Explicit provider auth cannot silently use an API-key fallback from the parent.
  const argv = ["-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"', "login", action === "login" ? "--device-auth" : "status"];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env, stdio: "inherit", shell: false });
    child.once("error", () => reject(new ConfigurationError("config_auth_spawn_failed")));
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

/** Portable task-checkpoint.config.v1 contract. Mirrored byte-for-byte in the helper. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

export const CONFIG_VERSION = "task-checkpoint.config.v1" as const;
const CONFIG_MAX_BYTES = 65536;
export type DecisionProvider = "openrouter" | "typesafe";
export type ConfigModel = { model: "gpt-6-sol" | "gpt-6-luna"; effort: "medium" | "high" };
export type AgentServiceConfig = {
  concurrency: number; max_workers: number; max_native_turns: number; max_tool_calls: number;
  deadline_ms: number; max_rounds: number; data_policy: "metadata_only" | "prepared_fragments";
  external_score_max_calls: number;
};
export type PortableConfig = {
  schema_version: typeof CONFIG_VERSION;
  recorder: { state_dir: string; helper_command: string[]; concurrency: number; max_jobs: number;
    timeout_ms: number; lease_ms: number; page_bytes: number; page_limit: number; stdout_bytes: number };
  codex: { executable: string | null; home: string | null; supervisor: ConfigModel; semantic_worker: ConfigModel; eval: ConfigModel };
  scoring: { provider: DecisionProvider; model: string; api_key_env: string;
    limits: { deadline_ms: number; max_request_bytes: number; max_response_bytes: number } };
  agent_service: AgentServiceConfig;
};
export class ConfigurationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ConfigurationError"; }
}
function fail(code: string): never { throw new ConfigurationError(code); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("config_object_required");
  const out = value as Record<string, unknown>;
  if (Object.keys(out).some(key => !fields.includes(key))) fail("config_unknown_field");
  return out;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("config_invalid_string");
  return value;
}
const RESERVED_ENV_NAMES = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "CODEX_HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "IFS", "CDPATH", "RUBYOPT", "PERL5OPT", "OPENSSL_CONF", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const RESERVED_ENV_PREFIX = /^(?:BUN_|NODE_|LD_|DYLD_|PYTHON|TASK_CHECKPOINT_RECORD_|CLAUDE_|PI_)/u;
/** A credential reference cannot become a runtime/preload, routing or profile override. */
export function validateApiKeyEnvName(value: unknown): string {
  const name = text(value, 128);
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) fail("config_invalid_api_key_env");
  if (RESERVED_ENV_NAMES.includes(name) || RESERVED_ENV_PREFIX.test(name) || /(?:^|_)PROXY$/u.test(name)) fail("config_reserved_api_key_env");
  return name;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) fail("config_invalid_limit");
  return result;
}
function filePath(value: unknown, base: string): string {
  const path = text(value);
  if (path.startsWith("~") || path.includes("$") || path.startsWith("//") || path.split(/[\\/]/u).includes("..")) fail("config_path_requires_literal_location");
  return resolve(base, path);
}
function model(value: unknown, fallback: ConfigModel): ConfigModel {
  if (value === undefined) return { ...fallback };
  const m = object(value, ["model", "effort"]);
  const selected = m.model === undefined ? fallback.model : m.model;
  const effort = m.effort === undefined ? fallback.effort : m.effort;
  if (selected !== "gpt-6-sol" && selected !== "gpt-6-luna") fail("config_unsupported_codex_model");
  if (effort !== "medium" && effort !== "high") fail("config_unsupported_reasoning_effort");
  return { model: selected, effort };
}
export function configTemplate(provider: DecisionProvider = "openrouter"): PortableConfig {
  if (provider !== "openrouter" && provider !== "typesafe") fail("config_unsupported_provider");
  return {
    schema_version: CONFIG_VERSION,
    recorder: { state_dir: "./.local/task-checkpoint-record", helper_command: ["ultrafast-atif-helper"],
      concurrency: 2, max_jobs: 64, timeout_ms: 10000, lease_ms: 30000,
      page_bytes: 1048576, page_limit: 100, stdout_bytes: 2097152 },
    codex: { executable: null, home: null, supervisor: { model: "gpt-6-sol", effort: "medium" },
      semantic_worker: { model: "gpt-6-luna", effort: "medium" }, eval: { model: "gpt-6-luna", effort: "high" } },
    scoring: { provider, model: provider === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0",
      api_key_env: provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY",
      limits: { deadline_ms: 20000, max_request_bytes: 65536, max_response_bytes: 1048576 } },
    agent_service: { concurrency: 2, max_workers: 2, max_native_turns: 3, max_tool_calls: 64,
      deadline_ms: 180000, max_rounds: 2, data_policy: "metadata_only", external_score_max_calls: 0 },
  };
}
/** No environment expansion, credential discovery, executable launch or directory creation. */
export function parseConfig(value: unknown, baseDir: string): PortableConfig {
  if (!isAbsolute(baseDir) || resolve(baseDir) !== baseDir) fail("config_base_absolute_required");
  const root = object(value, ["schema_version", "recorder", "codex", "scoring", "agent_service"]);
  if (root.schema_version !== CONFIG_VERSION) fail("config_unsupported_version");
  const s = root.scoring === undefined ? {} : object(root.scoring, ["provider", "model", "api_key_env", "limits"]);
  const provider = s.provider === undefined ? "openrouter" : s.provider;
  if (provider !== "openrouter" && provider !== "typesafe") fail("config_unsupported_provider");
  const defaults = configTemplate(provider);
  const r = root.recorder === undefined ? {} : object(root.recorder, Object.keys(defaults.recorder));
  const c = root.codex === undefined ? {} : object(root.codex, Object.keys(defaults.codex));
  const agent = root.agent_service === undefined ? {} : object(root.agent_service, Object.keys(defaults.agent_service));
  const dataPolicy = agent.data_policy === undefined ? "metadata_only" : agent.data_policy;
  if (dataPolicy !== "metadata_only" && dataPolicy !== "prepared_fragments") fail("config_unsupported_agent_data_policy");
  const limits = s.limits === undefined ? {} : object(s.limits, Object.keys(defaults.scoring.limits));
  if (s.model !== undefined && s.model !== defaults.scoring.model) fail("config_unsupported_scoring_model");
  const apiKeyEnv = validateApiKeyEnvName(s.api_key_env === undefined ? defaults.scoring.api_key_env : s.api_key_env);
  const command = r.helper_command === undefined ? defaults.recorder.helper_command : r.helper_command;
  if (!Array.isArray(command) || command.length === 0 || command.length > 16) fail("config_helper_argv_required");
  const helper = command.map(arg => text(arg));
  if (helper[0]!.includes("/") || helper[0]!.includes("\\")) helper[0] = filePath(helper[0], baseDir);
  else if (!/^[a-zA-Z0-9._-]+$/u.test(helper[0]!)) fail("config_invalid_helper_executable");
  const result: PortableConfig = {
    schema_version: CONFIG_VERSION,
    recorder: {
      state_dir: filePath(r.state_dir === undefined ? defaults.recorder.state_dir : r.state_dir, baseDir), helper_command: helper,
      concurrency: integer(r.concurrency, 2, 1, 32), max_jobs: integer(r.max_jobs, 64, 1, 10000),
      timeout_ms: integer(r.timeout_ms, 10000, 100, 60000), lease_ms: integer(r.lease_ms, 30000, 1000, 120000),
      page_bytes: integer(r.page_bytes, 1048576, 1024, 4194304), page_limit: integer(r.page_limit, 100, 1, 1000),
      stdout_bytes: integer(r.stdout_bytes, 2097152, 1024, 8388608),
    },
    codex: { executable: c.executable === undefined || c.executable === null ? null : filePath(c.executable, baseDir),
      home: c.home === undefined || c.home === null ? null : filePath(c.home, baseDir),
      supervisor: model(c.supervisor, defaults.codex.supervisor),
      semantic_worker: model(c.semantic_worker, defaults.codex.semantic_worker), eval: model(c.eval, defaults.codex.eval) },
    scoring: { provider, model: defaults.scoring.model, api_key_env: apiKeyEnv,
      limits: { deadline_ms: integer(limits.deadline_ms, 20000, 1, 20000),
        max_request_bytes: integer(limits.max_request_bytes, 65536, 1, 65536),
        max_response_bytes: integer(limits.max_response_bytes, 1048576, 1, 1048576) } },
    agent_service: { concurrency: integer(agent.concurrency, 2, 1, 32), max_workers: integer(agent.max_workers, 2, 1, 32),
      max_native_turns: integer(agent.max_native_turns, 3, 2, 33), max_tool_calls: integer(agent.max_tool_calls, 64, 1, 256),
      deadline_ms: integer(agent.deadline_ms, 180000, 1000, 300000), max_rounds: integer(agent.max_rounds, 2, 1, 32),
      data_policy: dataPolicy, external_score_max_calls: integer(agent.external_score_max_calls, 0, 0, 1) },
  };
  if (result.recorder.lease_ms <= result.recorder.timeout_ms + 500) fail("config_lease_shorter_than_deadline");
  if (result.agent_service.max_workers + 1 > result.agent_service.max_native_turns) fail("config_agent_native_turn_budget_too_small");
  if (result.agent_service.concurrency > result.agent_service.max_workers) fail("config_agent_concurrency_exceeds_workers");
  return result;
}
/** Duplicate keys are rejected before JSON.parse; errors never echo config values. */
function decode(bytes: Uint8Array): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("config_invalid_utf8"); }
  let at = 0, nodes = 0;
  const space = () => { while (/[ \t\r\n]/u.test(source[at] ?? "x")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) { const ch = source[at++]; if (ch === "\\") at++; else if (ch === '"') return JSON.parse(source.slice(start, at)); }
    return fail("config_invalid_json");
  };
  const scan = (depth: number): void => {
    if (depth > 16 || ++nodes > 4096) fail("config_json_budget");
    space();
    if (source[at] === '"') { string(); return; }
    if (source[at] === "{" || source[at] === "[") {
      const obj = source[at++] === "{", end = obj ? "}" : "]", seen = new Set<string>();
      space(); if (source[at] === end) { at++; return; }
      while (at < source.length) {
        space(); if (obj) { if (source[at] !== '"') fail("config_invalid_json"); const key = string();
          if (seen.has(key)) fail("config_duplicate_key"); seen.add(key); space(); if (source[at++] !== ":") fail("config_invalid_json"); }
        scan(depth + 1); space(); const next = source[at++]; if (next === end) return; if (next !== ",") fail("config_invalid_json");
      }
      fail("config_invalid_json");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(at));
    if (!token) fail("config_invalid_json"); at += token[0].length;
  };
  try { scan(0); space(); if (at !== source.length) fail("config_invalid_json"); return JSON.parse(source); }
  catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_invalid_json"); }
}
function configPath(file: string): string {
  const path = filePath(file, process.cwd());
  if (path.split(sep).some(part => /^\.env(?:\.|$)|^(?:auth|credentials|secrets|tokens?)(?:\.|$)|\.(?:pem|key|p12|pfx)$/iu.test(part))) fail("config_credential_path_denied");
  return path;
}
function checkParents(path: string): void {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail("config_symlink_denied");
    if (current !== path && !info.isDirectory()) fail("config_parent_not_directory");
  }
}
export function loadConfig(file: string, expectedSha256?: string): PortableConfig {
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) fail("config_expected_digest_invalid");
  try {
    const path = configPath(file); checkParents(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) fail("config_regular_unaliased_file_required");
      if (stat.size > CONFIG_MAX_BYTES) fail("config_byte_budget");
      const bytes = Buffer.alloc(stat.size); let read = 0;
      while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) fail("config_changed"); read += n; }
      const after = fstatSync(fd), current = lstatSync(path);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) fail("config_changed");
      if (expectedSha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectedSha256) fail("config_digest_mismatch");
      return parseConfig(decode(bytes), dirname(path));
    } finally { closeSync(fd); }
  } catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_read_failed"); }
}
/** New regular file only; the parent must exist. No state/profile/authentication effects. */
export function writeConfig(file: string, provider: DecisionProvider = "openrouter"): void {
  const content = JSON.stringify(configTemplate(provider), null, 2) + "\n";
  try {
    const path = configPath(file); checkParents(dirname(path));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
  } catch (error) { if (error instanceof ConfigurationError) throw error; return fail("config_create_new_failed"); }
}
export function checkConfigReport(config: PortableConfig): object {
  return { schema_version: "task-checkpoint.config-check.v1", valid: true, config,
    credentials: "environment_variable_names_only_not_inspected", auth_checked: false, model_called: false,
    effects: "none", note: "A valid config does not verify executable availability, native login, provider access or model quality." };
}
export function configSchema(): object {
  const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
  const path = { type: "string", minLength: 1, maxLength: 4096, description: "Literal absolute or config-directory-relative path; no tilde, dollar expansion or parent components." };
  const model = { type: "object", additionalProperties: false, properties: {
    model: { enum: ["gpt-6-sol", "gpt-6-luna"] }, effort: { enum: ["medium", "high"] } } };
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://github.com/lwyBZss8924d/task-checkpoint-record/config/task-checkpoint.config.schema.json",
    title: "Unified task checkpoint configuration v1", type: "object", additionalProperties: false, required: ["schema_version"],
    properties: {
      schema_version: { const: CONFIG_VERSION },
      recorder: { type: "object", additionalProperties: false, properties: {
        state_dir: path, helper_command: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 4096 } },
        concurrency: integer(1, 32), max_jobs: integer(1, 10000), timeout_ms: integer(100, 60000), lease_ms: integer(1000, 120000),
        page_bytes: integer(1024, 4194304), page_limit: integer(1, 1000), stdout_bytes: integer(1024, 8388608) } },
      codex: { type: "object", additionalProperties: false, properties: {
        executable: { anyOf: [path, { type: "null" }] }, home: { anyOf: [path, { type: "null" }] },
        supervisor: model, semantic_worker: model, eval: model } },
      agent_service: { type: "object", additionalProperties: false, description: "Policy ceilings for explicit native agent activation only; configuration never starts services or models.", properties: {
        concurrency: integer(1, 32), max_workers: integer(1, 32),
        max_native_turns: { ...integer(2, 33), description: "Admitted native turn/start operations per round, including one supervisor turn and at most max_workers worker turns. Native internal HTTP retries and tool-followup model requests are not separately observable or hard-limited by this counter." },
        max_tool_calls: integer(1, 256), deadline_ms: integer(1000, 300000), max_rounds: integer(1, 32),
        data_policy: { enum: ["metadata_only", "prepared_fragments"] }, external_score_max_calls: integer(0, 1) } },
      scoring: { type: "object", additionalProperties: false, properties: {
        provider: { enum: ["openrouter", "typesafe"] }, model: { enum: ["typesafe/jev-1.13-20260917", "jev-1.13.0"] },
        api_key_env: { type: "string", pattern: "^[A-Z_][A-Z0-9_]{0,127}$", not: { anyOf: [
          { enum: RESERVED_ENV_NAMES }, { pattern: RESERVED_ENV_PREFIX.source }, { pattern: "(?:^|_)PROXY$" } ] } },
        limits: { type: "object", additionalProperties: false, properties: {
          deadline_ms: integer(1, 20000), max_request_bytes: integer(1, 65536), max_response_bytes: integer(1, 1048576) } } },
        allOf: [{ if: { properties: { provider: { const: "typesafe" } }, required: ["provider"] },
          then: { properties: { model: { const: "jev-1.13.0" } } }, else: { properties: { model: { const: "typesafe/jev-1.13-20260917" } } } }] },
    }, description: "Runtime also enforces literal-path rules, lease_ms > timeout_ms + 500, agent concurrency <= max_workers and max_workers + 1 <= max_native_turns. Unknown keys are errors; no endpoints or inline credentials." };
}

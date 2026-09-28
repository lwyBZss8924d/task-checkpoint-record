/** Requested model identities are exact; callers must opt into a different selection. */
export type ModelRole = "supervisor" | "semantic-worker" | "eval";
export type ModelSelection = { model: "gpt-6-sol" | "gpt-6-luna"; effort: "medium" | "high" };
/** Explicit offline-contract/test support; no open-ended version range. */
export const SUPPORTED_CODEX_VERSIONS = ["0.157.1", "0.158.0"] as const;
export type SupportedCodexVersion = typeof SUPPORTED_CODEX_VERSIONS[number];

export function selectModel(role: ModelRole = "supervisor", selection?: ModelSelection): ModelSelection {
  if (!["supervisor", "semantic-worker", "eval"].includes(role)) throw new Error("invalid_model_role");
  const value = selection ?? (role === "supervisor"
    ? { model: "gpt-6-sol", effort: "medium" }
    : { model: "gpt-6-luna", effort: role === "eval" ? "high" : "medium" });
  if (!["gpt-6-sol", "gpt-6-luna"].includes(value.model) || !["medium", "high"].includes(value.effort)) {
    throw new Error("invalid_model_selection");
  }
  return { model: value.model, effort: value.effort } as ModelSelection;
}

/** Verified against Codex 0.157.1 and 0.158.0 config schemas; not an all-tools deny policy. */
export const RESTRICTED_CONFIG: Readonly<Record<string, string | number | boolean | object>> = Object.freeze({
  model_provider: "openai", forced_login_method: "chatgpt", cli_auth_credentials_store: "file",
  approval_policy: "never", approvals_reviewer: "user", sandbox_mode: "read-only",
  web_search: "disabled", project_doc_max_bytes: 0, hide_agent_reasoning: true,
  show_raw_agent_reasoning: false, model_reasoning_summary: "none", notify: [], mcp_servers: {},
  "agents.enabled": false, "skills.include_instructions": false,
  "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
  "features.shell_tool": false, "features.apps": false, "features.plugins": false,
  "features.multi_agent": false, "features.multi_agent_v2": false,
  "features.hooks": false, "features.memories": false, "features.goals": false,
  "features.code_mode": false, "features.browser_use": false, "features.computer_use": false,
  "features.image_generation": false, "features.view_image": false,
  "features.tool_suggest": false, "features.skill_mcp_dependency_install": false,
  "features.skip_host_skill_discovery": true, "features.shell_snapshot": false,
  "features.sleep_tool": false, "features.token_budget": false,
  "features.request_permissions_tool": false, "features.send_message_to_user_async": false,
  "features.deferred_executor": false, "features.daemon_auto_start": false,
  "features.remote_plugin": false, "features.unbounded_connection_retries": false,
  "analytics.enabled": false, "feedback.enabled": false,
  "otel.exporter": "none", "otel.trace_exporter": "none", "otel.log_user_prompt": false,
});

function tomlLiteral(value: string | number | boolean | object): string {
  if (Array.isArray(value)) return "[]";
  if (typeof value === "object") return "{}";
  return JSON.stringify(value);
}

export function appServerArguments(selection: ModelSelection): string[] {
  const settings = { ...RESTRICTED_CONFIG, model: selection.model, model_reasoning_effort: selection.effort };
  return ["app-server", "--stdio", "--strict-config", ...Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${tomlLiteral(value)}`])];
}

/** Reviewable dedicated-home config. Callers own creation, login and permissions. */
export function dedicatedConfigText(): string {
  return "# Dedicated task-checkpoint-record home; no credential copying.\n" +
    Object.entries({ ...RESTRICTED_CONFIG, model: "gpt-6-sol", model_reasoning_effort: "medium" })
      .map(([key, value]) => `${key} = ${tomlLiteral(value)}`).join("\n") + "\n";
}

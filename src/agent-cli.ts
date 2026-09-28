import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createAgentSession, runAgentTurn, type AgentSessionOptions } from "./agent-runtime.ts";
import { materializeAgentActivation, selectAgentScoringCredential, type AgentScoringCredential } from "./agent-config.ts";
import { bunRuntimeFlags } from "./bun-runtime.ts";
import { parseConfig, type PortableConfig } from "./config.ts";
import { configuredAppServerOptions } from "./config-runtime.ts";
import { createCliPtcHelper, createCliPtcScorer, createPtcTools, validatePreparedPacketAdmission } from "./ptc-tools.ts";
import type { Store } from "./store.ts";
import { SupervisorDaemon, type SupervisorPtcFactory, type SupervisorRuntimeFactory } from "./supervisor.ts";
import { SupervisorStore } from "./supervisor-store.ts";
import type { SupervisorActivation } from "./supervisor-types.ts";
import { absolute, canonical, childEnvironment, fail, integer, parseJson, privateState, readFileBounded, sha, str } from "./security.ts";

type Options = Map<string, string[]>;
const option = (options: Options, name: string, required = false): string | undefined => {
  const value = options.get(name)?.[0]; if (required && value === undefined) fail("missing_option"); return value;
};
function allowed(options: Options, names: string[]): void {
  for (const key of options.keys()) if (!["state", "config", "config-sha256", "json", ...names].includes(key)) fail("unknown_option");
}
function number(options: Options, key: string, fallback: number, min: number, max: number): number {
  const raw = option(options, key); if (raw !== undefined && !/^(0|[1-9][0-9]*)$/u.test(raw)) fail("invalid_integer");
  return integer(raw === undefined ? fallback : Number(raw), min, max);
}
function boolean(options: Options, key: string): boolean {
  const raw = option(options, key); if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true; return fail("invalid_boolean_option");
}

/** The child may register readiness, but cannot extract sources or launch models until this resolves. */
async function awaitStartupAck(nonce: string, signal: AbortSignal): Promise<void> {
  if (!/^[a-f0-9-]{36}$/u.test(nonce)) fail("agent_startup_nonce_invalid");
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false;
    const cleanup = () => { clearTimeout(timer); process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", end); process.stdin.pause(); signal.removeEventListener("abort", aborted); };
    const finish = (code?: string) => { if (settled) return; settled = true; cleanup(); if (code) { try { fail(code); } catch (error) { reject(error); } } else resolve(); };
    const data = (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 128) { finish("agent_startup_ack_invalid"); return; }
      if (bytes.includes(10)) finish(bytes.toString("utf8") === nonce + "\n" ? undefined : "agent_startup_ack_invalid"); };
    const end = () => finish("agent_startup_parent_eof"), aborted = () => finish("agent_startup_cancelled");
    const timer = setTimeout(() => finish("agent_startup_ack_deadline"), 10000);
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", end);
    signal.addEventListener("abort", aborted, { once: true }); process.stdin.resume(); if (signal.aborted) aborted();
  });
}

/** This is used only before acknowledgement, when the gated child has started no descendants. */
async function closeUnacknowledgedChild(child: ChildProcess): Promise<boolean> {
  child.stdin?.destroy(); if (!child.pid) return true;
  let closed = child.exitCode !== null || child.signalCode !== null;
  child.once("close", () => { closed = true; });
  const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch (error: any) { if (error?.code !== "ESRCH") return false; } return true; };
  if (!signal("SIGTERM")) return false;
  const graceful = Date.now() + 1000; while (!closed && Date.now() < graceful) await Bun.sleep(10);
  if (!closed && !signal("SIGKILL")) return false;
  const killed = Date.now() + 1000; while (!closed && Date.now() < killed) await Bun.sleep(10);
  try { process.kill(-child.pid, 0); return false; } catch (error: any) { return closed && error?.code === "ESRCH"; }
}

/** Revalidate the immutable, credential-free runtime snapshot before native work. */
function activationConfig(activation: SupervisorActivation, state: string): PortableConfig {
  if (sha(canonical(activation.policy)) !== activation.policy_sha256) fail("agent_policy_digest_mismatch");
  const config = parseConfig(activation.runtime_config, state);
  if (canonical(config) !== canonical(activation.runtime_config) || sha(canonical(config)) !== activation.policy.config_sha256 ||
      config.recorder.state_dir !== state) fail("agent_runtime_config_mismatch");
  for (const packet of activation.policy.content.prepared_packets) validatePreparedPacketAdmission(packet, config.scoring);
  configuredAppServerOptions(config, "supervisor", state);
  return config;
}

export function preflightAgentDaemon(store: SupervisorStore, daemonId: string, environment: NodeJS.ProcessEnv): {
  activations: SupervisorActivation[]; credential?: AgentScoringCredential;
} {
  const activations = store.activations(str(daemonId, 128));
  if (activations.length === 0) fail("agent_active_admission_required");
  let credential: AgentScoringCredential | undefined, provider: string | undefined;
  for (const activation of activations) {
    const config = activationConfig(activation, store.base.state);
    const selected = selectAgentScoringCredential(config, activation.policy, environment);
    if (selected) {
      if (credential && (credential.envName !== selected.envName || provider !== config.scoring.provider || credential.value !== selected.value))
        fail("agent_daemon_scoring_profile_conflict");
      credential = selected; provider = config.scoring.provider;
    }
  }
  return { activations, ...(credential ? { credential } : {}) };
}

/** Native children receive their adapter's allowlisted environment, never this host-only credential. */
export function createConfiguredAgentDaemon(store: SupervisorStore, daemonId: string, environment: NodeJS.ProcessEnv): SupervisorDaemon {
  const admitted = preflightAgentDaemon(store, daemonId, environment);
  const known = new Map(admitted.activations.map(activation => [activation.activation_id, activation.policy_sha256]));
  const contexts = new Map<string, { config: PortableConfig; workDir: string; scorer?: ReturnType<typeof createCliPtcScorer> }>();
  const context = (activation: SupervisorActivation) => {
    if (known.get(activation.activation_id) !== activation.policy_sha256) fail("agent_activation_requires_service_restart");
    let cached = contexts.get(activation.activation_id);
    if (!cached) {
      const config = activationConfig(activation, store.base.state);
      const parent = privateState(join(store.base.state, "agent-runtime"), true);
      const workDir = privateState(join(parent, sha(activation.activation_id + ":" + activation.policy_sha256)), true);
      const credential = activation.policy.external_score_max_calls > 0 ? admitted.credential : undefined;
      if (activation.policy.external_score_max_calls > 0 && !credential) fail("agent_provider_key_missing");
      cached = { config, workDir, ...(credential ? { scorer: createCliPtcScorer({ command: config.recorder.helper_command,
        workDir, config, configSha256: activation.policy.config_sha256, credential }) } : {}) };
      contexts.set(activation.activation_id, cached);
    }
    return cached;
  };
  const runtimeOptions = (activation: SupervisorActivation, role: "supervisor" | "semantic-worker"): Omit<AgentSessionOptions, "tools"> => {
    const current = context(activation), policy = activation.policy;
    return { ...configuredAppServerOptions(current.config, role, current.workDir),
      selection: { ...(role === "supervisor" ? policy.supervisor : policy.worker) },
      allowedDataClasses: policy.content.native_content === "metadata" ? ["metadata_only"] : ["metadata_only", "synthetic", "redacted"],
      limits: { deadlineMs: policy.round_timeout_ms, maxTurns: policy.max_rounds,
        maxToolCalls: policy.tool_call_budget, maxToolTotalBytes: policy.tool_output_bytes,
        maxToolResultBytes: Math.min(32768, policy.tool_output_bytes), toolDeadlineMs: policy.round_timeout_ms,
        maxConcurrentTools: policy.worker_concurrency, maxInputBytes: 131072, maxOutputBytes: 65536 } };
  };
  const runtimeFactory: SupervisorRuntimeFactory = {
    createSupervisor: (activation, tools, signal) => createAgentSession({ ...runtimeOptions(activation, "supervisor"), tools, signal }),
    runWorker: (activation, _task, tools, turn) => runAgentTurn({ ...runtimeOptions(activation, "semantic-worker"), tools, ...turn }),
  };
  const ptcFactory: SupervisorPtcFactory = ({ activation, snapshot, budget, assertActive, onReceipt }) => {
    const current = context(activation);
    return createPtcTools({ activationId: activation.activation_id, snapshot,
      helper: createCliPtcHelper({ command: current.config.recorder.helper_command, workDir: current.workDir,
        timeoutMs: current.config.recorder.timeout_ms, maxOutputBytes: current.config.recorder.stdout_bytes }),
      policy: activation.policy.content, budget, assertActive, onReceipt, scoring: current.scorer });
  };
  return new SupervisorDaemon({ store, daemon_id: daemonId, runtimeFactory, ptcFactory, maxResidentSessions: 2 });
}

export async function agentCommand(input: { command: string; options: Options; store: Store; config?: PortableConfig;
  cliEntrypoint: string; environment?: NodeJS.ProcessEnv }): Promise<unknown> {
  const { command, options, store, config, cliEntrypoint } = input;
  const environment = input.environment ?? process.env, agents = new SupervisorStore(store);
  switch (command) {
    case "agent activate": {
      allowed(options, ["file"]); if (!config) fail("config_required");
      const admission = materializeAgentActivation(config, parseJson(readFileBounded(absolute(option(options, "file", true)), 2 * 1024 * 1024).toString("utf8")), store.state);
      configuredAppServerOptions(config, "supervisor", store.state);
      selectAgentScoringCredential(config, admission.policy, environment);
      const activation = agents.activate(admission);
      return { schema_version: "task-checkpoint-record.agent-activated.v1", activation_id: activation.activation_id,
        binding_id: activation.binding_id, daemon_id: activation.daemon_id, policy_sha256: activation.policy_sha256,
        config_sha256: activation.policy.config_sha256, active: activation.active, daemon_started: false };
    }
    case "agent status": allowed(options, []); return agents.status();
    case "agent jobs": allowed(options, ["activation", "job-state", "limit", "offset"]); return agents.jobs({
      activation_id: option(options, "activation"), state: option(options, "job-state"),
      limit: number(options, "limit", 20, 1, 100), offset: number(options, "offset", 0, 0, 10000) });
    case "agent resolve": allowed(options, ["link", "fields"]); return agents.resolve(option(options, "link", true)!, option(options, "fields")?.split(","));
    case "agent deactivate": allowed(options, ["activation"]); return { deactivated: agents.deactivate(option(options, "activation", true)!) };
    case "agent retry": allowed(options, ["run"]); return { queued: agents.retry(option(options, "run", true)!), automatic_retry: false };
    case "agent cancel": allowed(options, ["run"]); return { cancellation_requested: agents.cancel(option(options, "run", true)!) };
    case "agent verify": {
      allowed(options, ["run", "binding", "turn", "window", "consume-strict"]);
      if (option(options, "run")) {
        if (["binding", "turn", "window", "consume-strict"].some(name => options.has(name))) fail("conflicting_option");
        return agents.verify(option(options, "run")!);
      }
      const consume = boolean(options, "consume-strict"); if (consume && !option(options, "turn")) fail("native_turn_required_for_guard");
      return agents.cachedReview({ binding_id: option(options, "binding", true)!, turn_id: option(options, "turn") ?? null,
        window_id: option(options, "window", true)!, consume_strict: consume });
    }
    case "agent stop": allowed(options, ["daemon"]); return { stop_requested: agents.requestStop(option(options, "daemon", true)!), policy: "cooperative_owned_runtime_shutdown" };
    case "agent start": {
      allowed(options, ["daemon", "startup-timeout-ms"]); const daemonId = str(option(options, "daemon", true), 128);
      if (process.platform === "win32") fail("agent_detached_process_groups_unsupported");
      const startupTimeout = number(options, "startup-timeout-ms", 2000, 1, 5000);
      const admission = preflightAgentDaemon(agents, daemonId, environment);
      const childEnv = childEnvironment("observer", environment);
      if (admission.credential) childEnv[admission.credential.envName] = admission.credential.value;
      const nonce = randomUUID();
      const child = spawn(process.execPath, [...bunRuntimeFlags(), cliEntrypoint, "agent", "run", "--state", store.state, "--daemon", daemonId, "--startup-nonce", nonce],
        { detached: true, stdio: ["pipe", "ignore", "ignore"], env: childEnv, shell: false });
      let failed = false; child.once("error", () => { failed = true; }); child.unref();
      const until = Date.now() + startupTimeout;
      let acknowledgementAttempted = false;
      try { while (!failed && Date.now() < until) {
        const row = agents.db.query("SELECT pid,heartbeat,state FROM agent_services WHERE daemon_id=?").get(daemonId) as { pid: number; heartbeat: number; state: string } | null;
        if (row && row.pid === child.pid && row.state === "waiting_for_ack" && row.heartbeat > Date.now() - 2000) {
          acknowledgementAttempted = true;
          let acknowledged = false;
          try { acknowledged = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), 500);
            child.stdin!.end(nonce + "\n", (error?: Error | null) => { clearTimeout(timer); resolve(!error); });
            child.stdin!.once("error", () => { clearTimeout(timer); resolve(false); });
          }); } catch { /* Delivery can be ambiguous; never retry or claim zero effects. */ }
          child.stdin?.destroy();
          let runningObserved = false;
          const admittedUntil = Date.now() + 500;
          while (acknowledged && Date.now() < admittedUntil) {
            const ready = agents.db.query("SELECT pid,state FROM agent_services WHERE daemon_id=?").get(daemonId) as { pid: number; state: string } | null;
            if (ready?.pid === child.pid && ready?.state === "running") { runningObserved = true; break; }
            if (!ready || ready.pid !== child.pid || ready.state === "stopped") break;
            await Bun.sleep(10);
          }
          return { schema_version: "task-checkpoint-record.agent-service.v1", state: acknowledged && runningObserved ? "start_admitted" : "admitted_unknown",
            daemon_id: daemonId, pid: child.pid, readiness: "owned_pid_observed_waiting_for_ack", acknowledgement_write_completed: acknowledged,
            running_observed_after_ack: runningObserved, explicit_start: true, automatic_retry: false };
        }
        await Bun.sleep(25);
      } } catch (error) {
        if (acknowledgementAttempted) return { schema_version: "task-checkpoint-record.agent-service.v1", state: "admitted_unknown",
          daemon_id: daemonId, pid: child.pid, readiness: "owned_pid_observed_waiting_for_ack", acknowledgement_write_completed: false,
          running_observed_after_ack: false, explicit_start: true, automatic_retry: false };
        if (!await closeUnacknowledgedChild(child)) fail("agent_startup_cleanup_unverified");
        throw error;
      }
      if (!await closeUnacknowledgedChild(child)) fail("agent_startup_cleanup_unverified");
      return fail("agent_service_start_not_observed");
    }
    case "agent run": {
      allowed(options, ["daemon", "once", "startup-nonce"]); const daemonId = str(option(options, "daemon", true), 128);
      if (boolean(options, "once") && option(options, "startup-nonce")) fail("conflicting_option");
      const daemon = createConfiguredAgentDaemon(agents, daemonId, environment), abort = new AbortController();
      const stop = () => abort.abort(); process.once("SIGTERM", stop); process.once("SIGINT", stop);
      try {
        if (boolean(options, "once")) return await daemon.once(abort.signal);
        const nonce = option(options, "startup-nonce");
        await daemon.run(abort.signal, nonce ? { beforeFirstWork: signal => awaitStartupAck(nonce, signal) } : undefined);
        return { state: "stopped", daemon_id: daemonId };
      } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); await daemon.close(); }
    }
    default: return fail("unknown_agent_command");
  }
}

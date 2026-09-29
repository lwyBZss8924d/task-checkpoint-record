/** Client-plugin entry: a reviewed config and explicit enablement precede every effect. */
import { isAbsolute, resolve } from "node:path";

export type PluginClient = "codex" | "claude" | "pi";
type Environment = Record<string, string | undefined>;
export type PluginHookPlan =
  | { disposition: "disabled" | "suppressed_role" | "unconfigured" | "invalid_configuration"; argv: null }
  | { disposition: "dispatch"; argv: string[] };

/** Pure planning: it does not inspect files, credentials, stdin, or a native profile. */
export function planPluginHook(client: PluginClient, env: Environment): PluginHookPlan {
  if (env.TCR_PLUGIN_ENABLED !== "1") return { disposition: "disabled", argv: null };
  if (env.TASK_CHECKPOINT_RECORD_WORKER === "1" ||
      (env.TASK_CHECKPOINT_RECORD_ROLE !== undefined && env.TASK_CHECKPOINT_RECORD_ROLE !== "master")) {
    return { disposition: "suppressed_role", argv: null };
  }
  const file = env.TCR_CONFIG, digest = env.TCR_CONFIG_SHA256, profile = env.TCR_PROFILE;
  if (!file || !digest || !profile) return { disposition: "unconfigured", argv: null };
  if ((client !== "codex" && client !== "claude" && client !== "pi") || file.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(file) || !isAbsolute(file) || resolve(file) !== file ||
      !/^[a-f0-9]{64}$/u.test(digest) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profile)) {
    return { disposition: "invalid_configuration", argv: null };
  }
  return { disposition: "dispatch", argv: ["hook", "--config", file, "--config-sha256", digest,
    "--client", client, "--profile", profile] };
}

/** Native hooks call only the bounded recorder hook front door, never an arbitrary command. */
export async function pluginHookMain(client: PluginClient, options: {
  env?: Environment;
  dispatch?: (argv: string[]) => Promise<void>;
  output?: (text: string) => void;
} = {}): Promise<void> {
  const plan = planPluginHook(client, options.env ?? process.env);
  if (plan.argv === null) {
    (options.output ?? (text => { process.stdout.write(text); }))("{}\n");
    return;
  }
  // Import after the guards: disabled or unconfigured installations never open state.
  const dispatch = options.dispatch ?? (async argv => { const { main } = await import("./cli.ts"); await main(argv); });
  await dispatch(plan.argv);
}

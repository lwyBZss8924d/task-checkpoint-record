import { fileURLToPath } from "node:url";

/** Source and installed artifacts preserve ../config/runtime.bunfig.toml relative to this module. */
export function bunRuntimeFlags(): string[] {
  const ownedConfig = fileURLToPath(new URL("../config/runtime.bunfig.toml", import.meta.url));
  return ["--no-env-file", "--no-install", "--config=" + ownedConfig];
}

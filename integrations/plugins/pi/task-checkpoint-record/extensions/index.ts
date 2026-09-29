import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerTaskCheckpointRecord, type PiContext, type PiEventMetadata, type PiRegistrar } from "../runtime/recorder/integrations/pi/task-checkpoint-record.v1.ts";
import { createPiBridge } from "./bridge.ts";

/** Pi 0.87.1 source contract b485fa3; registration itself has no runtime effects. */
export function registerPiExtension(pi: ExtensionAPI, options: Parameters<typeof createPiBridge>[1] = {}): void {
  const bridge = createPiBridge(fileURLToPath(new URL("../", import.meta.url)), {
    onDrop: error => { process.stderr.write(JSON.stringify({ schema_version: "task-checkpoint.pi-hook-diagnostic.v1", error }) + "\n"); },
    ...options
  });
  const registrar: PiRegistrar = {
    on(name, handler) {
      const observe = async (event: PiEventMetadata, context: PiContext): Promise<void> => {
        if (bridge.enabled()) await handler(event, context);
      };
      switch (name) {
        case "session_start": return pi.on("session_start", observe);
        case "session_before_compact": return pi.on("session_before_compact", observe);
        case "session_compact": return pi.on("session_compact", observe);
        case "turn_end": return pi.on("turn_end", observe);
        case "session_shutdown": return pi.on("session_shutdown", observe);
      }
    }
  };
  const remove = registerTaskCheckpointRecord(registrar, { role: "master", admit: bridge.admit, timeoutMs: 500, onDrop: bridge.dropped });
  let removeCleanup = () => {};
  removeCleanup = pi.on("session_shutdown", async () => { remove(); await bridge.close(); removeCleanup(); });
}

export default function taskCheckpointRecord(pi: ExtensionAPI): void { registerPiExtension(pi); }

/**
 * Synchronous read of just the `byok` section of PREVIOUSLY_HOME/config.json,
 * for the sync model-resolution paths (registry getModel/getDefaultModelId).
 *
 * fs/path come from process.getBuiltinModule, NOT static imports: the
 * registry is reachable from the "use workflow" bundle (turn-workflow →
 * agent → provider → bridge-model → registry), where static node:* imports
 * fail the build (workflow-node-module-error). This read only ever executes
 * in the Node server runtime (route/step context), never in a workflow body;
 * a runtime without getBuiltinModule degrades to null. Never throws — a
 * missing or corrupt config.json must not break model resolution (the
 * settings routes surface corruption honestly through readClientConfig).
 */

import { parseByok, type ClientByok } from "./byok-parse";

export function readClientByokSync(): ClientByok | null {
  const home = process.env.PREVIOUSLY_HOME?.trim();
  if (!home) return null;
  const getBuiltin = process.getBuiltinModule?.bind(process);
  if (!getBuiltin) return null;
  try {
    const fs = getBuiltin("node:fs") as typeof import("node:fs");
    const path = getBuiltin("node:path") as typeof import("node:path");
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    ) as { byok?: unknown };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return parseByok(raw.byok);
  } catch {
    return null;
  }
}

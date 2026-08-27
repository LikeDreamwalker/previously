/**
 * BYOK config shape + lenient read-side parse — PURE (env-only, no fs), so
 * the async client-config reader and the sync registry-side reader
 * (byok-sync.ts) share one source, and the module stays safe to import from
 * the workflow bundle's import graph.
 */

/**
 * The `byok` field of the client config — the user's own provider API key
 * (client mode's second engine, recommended next to local agent outsourcing).
 * `provider` is a BYOK_PROVIDERS key or "custom" (which requires baseUrl).
 * The apiKey is stored in plaintext — config.json is local single-user state.
 */
export interface ClientByok {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

/**
 * Lenient read-side byok parse: returned only when structurally recognizable.
 * `model` falls back to the client-CLI-injected PREVIOUSLY_DEFAULT_MODEL env
 * (the user's configured default model) when the stored section omits it —
 * the write side forces model non-empty, so a missing model means a legacy or
 * hand-edited file. Both empty → null.
 */
export function parseByok(raw: unknown): ClientByok | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.provider !== "string" || !b.provider.trim()) return null;
  if (typeof b.apiKey !== "string" || !b.apiKey) return null;
  const model =
    typeof b.model === "string" && b.model.trim()
      ? b.model
      : (process.env.PREVIOUSLY_DEFAULT_MODEL?.trim() ?? "");
  if (!model) return null;
  return {
    provider: b.provider,
    apiKey: b.apiKey,
    ...(typeof b.baseUrl === "string" && b.baseUrl.trim()
      ? { baseUrl: b.baseUrl }
      : {}),
    model,
  };
}

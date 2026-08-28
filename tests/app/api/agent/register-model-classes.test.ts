import { describe, it, expect, vi, afterEach } from "vitest";
import { getSerializationClass } from "workflow/internal/class-serialization";
// Side effect: registers the step-runtime model hosts (openai / anthropic /
// openai-compatible / bridge) into the global serialization registry.
import "@/app/api/agent/register-model-classes";
import { createModel } from "@/lib/models/provider";
import type { ModelConfig } from "@/lib/models/registry";
import openaiPkg from "@ai-sdk/openai/package.json";

// The workflow runtime serializes a LanguageModel crossing the
// workflow→step boundary via the class's static WORKFLOW_SERIALIZE and
// rebuilds it step-side through the registered host's WORKFLOW_DESERIALIZE.
// This spec exercises that exact round trip with the REAL @ai-sdk/openai —
// the BYOK regression it guards: createOpenAI keeps apiKey/baseURL inside
// dropped closures, so without provider.ts's re-attachment the step side
// rebuilt a keyless provider and every BYOK chat turn died with
// AI_LoadAPIKeyError ("OpenAI API key is missing").
const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

interface SerializedModelOptions {
  modelId: string;
  config: Record<string, unknown>;
}

interface ModelInstance {
  modelId: string;
  config: Record<string, unknown>;
}

function serialize(model: unknown): SerializedModelOptions {
  const ctor = (model as object).constructor as unknown as Record<
    symbol,
    (m: object) => SerializedModelOptions
  >;
  return ctor[WORKFLOW_SERIALIZE](model as object);
}

function deserialize(
  classId: string,
  payload: SerializedModelOptions,
): ModelInstance {
  const host = getSerializationClass(classId, globalThis) as unknown as Record<
    symbol,
    (o: SerializedModelOptions) => ModelInstance
  >;
  expect(host, `serialization class registered: ${classId}`).toBeDefined();
  return host[WORKFLOW_DESERIALIZE](payload);
}

// createOpenAI()(modelId) instantiates the Responses API model.
const RESPONSES_CLASS_ID = `class//@ai-sdk/openai@${openaiPkg.version}//OpenAIResponsesLanguageModel`;

// vi.stubEnv has no automatic restore in this config — unstub explicitly so
// WORKFLOW_TARGET_WORLD never leaks across cases.
afterEach(() => vi.unstubAllEnvs());

/** Minimal ModelConfig — only the fields createModel reads. */
function cfg(partial: Partial<ModelConfig> & { id: string }): ModelConfig {
  return {
    name: partial.id,
    provider: "byok",
    providerName: "Your API key",
    sdk: "openai",
    envKey: "",
    capabilities: { thinking: false, vision: false, maxTokens: 200_000 },
    defaultThinking: false,
    defaultEffort: "low",
    ...partial,
  } as ModelConfig;
}

describe("register-model-classes — BYOK workflow→step round trip", () => {
  it("carries apiKey/baseURL through serialization and rebuilds an authed model", async () => {
    const model = createModel(
      cfg({
        id: "byok/deepseek-chat",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-roundtrip-test",
      }),
    );

    const payload = serialize(model);
    // The regression core: both fields must be plain JSON-safe config
    // entries (provider.ts re-attaches them; createOpenAI alone does not).
    expect(payload.modelId).toBe("deepseek-chat");
    expect(payload.config.apiKey).toBe("sk-roundtrip-test");
    expect(payload.config.baseURL).toBe("https://api.deepseek.com");
    // JSON-safe, as the workflow serializer requires.
    expect(() => JSON.stringify(payload)).not.toThrow();

    const revived = deserialize(RESPONSES_CLASS_ID, payload);
    expect(revived.modelId).toBe("deepseek-chat");
    // The rebuilt model authenticates against the BYOK baseURL — not a bare
    // openai provider falling back to OPENAI_API_KEY.
    const headers = (await (revived.config.headers as () => unknown)()) as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer sk-roundtrip-test");
    const url = revived.config.url as (a: {
      path: string;
      modelId: string;
    }) => string;
    expect(url({ path: "/responses", modelId: "deepseek-chat" })).toMatch(
      /^https:\/\/api\.deepseek\.com/,
    );
  });

  it("does NOT write env-keyed providers' keys into the serialized payload", () => {
    // Env-key models (cloud deployments) stay undecorated: their key must not
    // land in the local .workflow-data/ store.
    vi.stubEnv("ROUNDTRIP_ENV_KEY", "sk-env-dummy");
    const model = createModel(
      cfg({
        id: "kimi-latest",
        provider: "moonshotai",
        baseURL: "https://api.moonshot.cn/v1",
        envKey: "ROUNDTRIP_ENV_KEY",
      }),
    );
    const payload = serialize(model);
    expect(payload.config.apiKey).toBeUndefined();
  });
});

describe("register-model-classes — env-key round trip on the local workflow world", () => {
  it("re-attaches the resolved env key when WORKFLOW_TARGET_WORLD=local and rebuilds an authed model", async () => {
    // Env-key models (cloud Kimi/Qwen) on the LOCAL world: the payload stays
    // in .workflow-data/, and the step side would otherwise fall back to
    // OPENAI_API_KEY and die standalone.
    vi.stubEnv("ROUNDTRIP_ENV_KEY", "sk-env-local");
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "local");
    const model = createModel(
      cfg({
        id: "kimi-latest",
        provider: "moonshotai",
        baseURL: "https://api.moonshot.cn/v1",
        envKey: "ROUNDTRIP_ENV_KEY",
      }),
    );

    const payload = serialize(model);
    expect(payload.modelId).toBe("kimi-latest");
    expect(payload.config.apiKey).toBe("sk-env-local");
    expect(payload.config.baseURL).toBe("https://api.moonshot.cn/v1");
    expect(() => JSON.stringify(payload)).not.toThrow();

    const revived = deserialize(RESPONSES_CLASS_ID, payload);
    const headers = (await (revived.config.headers as () => unknown)()) as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer sk-env-local");
    const url = revived.config.url as (a: {
      path: string;
      modelId: string;
    }) => string;
    expect(url({ path: "/responses", modelId: "kimi-latest" })).toMatch(
      /^https:\/\/api\.moonshot\.cn\/v1/,
    );
  });

  it("keeps the env key out of the payload when the world is NOT local", () => {
    // Cloud (shared-store) serialization: the deployment's env key must not
    // be written out — the step runtime re-reads it from its own env.
    vi.stubEnv("ROUNDTRIP_ENV_KEY", "sk-env-dummy");
    vi.stubEnv("WORKFLOW_TARGET_WORLD", "vercel");
    const model = createModel(
      cfg({
        id: "kimi-latest",
        provider: "moonshotai",
        baseURL: "https://api.moonshot.cn/v1",
        envKey: "ROUNDTRIP_ENV_KEY",
      }),
    );
    const payload = serialize(model);
    expect(payload.config.apiKey).toBeUndefined();
  });
});

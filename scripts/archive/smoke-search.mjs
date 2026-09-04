/**
 * Smoke test: DeepSeek's Anthropic-compatible endpoint + native web search
 * through @ai-sdk/anthropic's webSearch_20260209 provider-executed tool.
 *
 * Run:  node scripts/smoke-search.mjs
 * Env:  DEEPSEEK_API_KEY (read from .env.local automatically)
 *
 * This is the gating check for the webSearch tool (see chat 2026-07-17):
 * if this passes, the same call moves into a "use step" tool executor.
 */
import { readFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

// Minimal .env.local loader (no dotenv dependency).
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* rely on ambient env */
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY missing");
  process.exit(1);
}

const deepseekAnthropic = createAnthropic({
  baseURL: "https://api.deepseek.com/anthropic",
  apiKey: process.env.DEEPSEEK_API_KEY,
  // DeepSeek's Anthropic-compatible endpoint has one quirk: it wraps
  // web_search_tool_result ERRORS in an array ("content":[{error}]), while the
  // Anthropic spec (and @ai-sdk/anthropic's schema) expects a bare object
  // ("content":{error}). Normalize at the boundary so the SDK can parse.
  fetch: async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, res);
    }
    if (Array.isArray(body?.content)) {
      for (const block of body.content) {
        if (
          block?.type === "web_search_tool_result" &&
          Array.isArray(block.content)
        ) {
          const err = block.content.find(
            (c) => c?.type === "web_search_tool_result_error"
          );
          if (err) block.content = err;
        }
      }
    }
    return new Response(JSON.stringify(body), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  },
});

const started = Date.now();
try {
  const result = await generateText({
    model: deepseekAnthropic("deepseek-v4-flash"),
    tools: {
      web_search: deepseekAnthropic.tools.webSearch_20260209({ maxUses: 3 }),
    },
    prompt:
      "今天是2026年7月17日。请联网搜索:Vercel Workflow (workflow DevKit) 目前最新发布的版本号是多少?只回答版本号和发布日期,并给出来源。",
  });

  console.log("=== text ===");
  console.log(result.text);
  console.log("\n=== sources ===");
  console.log(JSON.stringify(result.sources ?? [], null, 2));
  console.log("\n=== finishReason ===", result.finishReason);
  console.log("=== elapsed ===", ((Date.now() - started) / 1000).toFixed(1), "s");
  const searchUsed =
    (result.sources?.length ?? 0) > 0 ||
    result.steps?.some((s) =>
      s.content?.some((p) => String(p.type).includes("tool"))
    );
  console.log("=== search actually used ===", searchUsed ? "YES" : "NO");
} catch (err) {
  console.error("SMOKE FAILED:", err?.message ?? err);
  if (err?.responseBody) console.error("response:", err.responseBody);
  process.exit(1);
}

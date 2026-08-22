/**
 * Web search — provider adapters behind a neutral contract.
 *
 * The webSearch tool's interface (query in → answer + sources + recommendation
 * out) is OURS; nothing DeepSeek- or Anthropic-shaped may leak out of this
 * module. Today there is one adapter: DeepSeek V4 Flash's native server-side
 * search, reached through DeepSeek's Anthropic-compatible endpoint (the
 * OpenAI-compatible /v1 endpoint cannot express provider-executed tools).
 * Future adapters (Claude native webSearch, Tavily for keyless demo) drop in
 * behind the same contract and MUST also produce the `recommendation` field.
 *
 * DeepSeek adapter specifics (not the contract — just this adapter):
 * - `web_search` is executed on DeepSeek's servers, which ingest the full
 *   page content during inference; the caller only ever sees the model's
 *   synthesized answer + citation URLs. No raw page content or snippets are
 *   exposed — that's why the main agent also has the separate `webFetch` tool
 *   to read a specific page on demand.
 * - `webSearch_20260209` is the @ai-sdk/anthropic SDK's method name for the
 *   provider-executed search tool, not our versioning — the SDK version is
 *   the authority for when to update it.
 *
 * @security — provider coupling. webSearch is currently a DEEPSEEK-ONLY
 * capability: this adapter always reaches `api.deepseek.com` and always needs
 * a `DEEPSEEK_API_KEY`, INDEPENDENT of the user's chosen chat model. If a
 * deployment's user selects Anthropic/OpenAI as the main model but omits
 * `DEEPSEEK_API_KEY`, webSearch will error rather than silently degrade.
 * A non-DeepSeek deployment must either (a) provide a `DEEPSEEK_API_KEY` for
 * this infra call, or (b) add a new adapter behind the `WebSearchResult`
 * contract (e.g. Claude native webSearch, Tavily) and dispatch on it here.
 * Do NOT let a missing key crash the turn — `webSearchExecute` gates on it
 * and returns a user-facing error string before any model call runs.
 *
 * Model roles: this is an INFRASTRUCTURE model call (like recall in
 * lib/episodic/flash/recall.ts) — the user-facing Pro model choice is not
 * affected. The call itself runs on the unified sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts): thinking ON at effort "low" (via the
 * Anthropic-shaped effort mapping — this adapter speaks the Anthropic
 * protocol), a 6-step cap, and a 60s wall-clock budget. The provider path is
 * unchanged: the runner receives a PRE-BUILT model instance so the custom
 * endpoint + normalizing fetch stay exactly as they were.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import {
  runSubAgent,
  type SubAgentProgressRef,
} from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
  /** VAR-style advice to the main agent: what the results suggest, which
   *  sources look strongest, what's uncertain, and whether fetching a
   *  specific page with webFetch would help. Part of the neutral contract. */
  recommendation: string;
  /** URLs the main agent might webFetch for deeper reading. */
  suggestedReads: Array<{ url: string; title: string; reason: string }>;
}

/** Server-side search rounds Flash may use per query. */
const MAX_SEARCHES_PER_QUERY = 3;

/**
 * DeepSeek's Anthropic-compatible endpoint has one spec deviation (verified
 * 2026-07-17, scripts/smoke-search.mjs): web_search_tool_result ERRORS come
 * wrapped in an array ("content":[{error}]) where the Anthropic spec — and
 * @ai-sdk/anthropic's response schema — expect a bare object. Normalize at
 * the fetch boundary so the SDK can parse the response.
 */
const normalizingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  const content = (body as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block?.type === "web_search_tool_result" &&
        Array.isArray(block.content)
      ) {
        const err = (block.content as Array<Record<string, unknown>>).find(
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
};

// ─── Structured output schema: searchReport ───────────────────────

/** Zod input schema — also the runner's report-validation schema. */
const searchReportInputSchema = z.object({
  answer: z
    .string()
    .catch("")
    .describe("Concise cited answer (2-5 paragraphs), grounded in what you actually found."),
  recommendation: z
    .string()
    .catch("")
    .describe(
      "VAR-style advice to the main agent: what the results suggest, " +
      "which sources look strongest, what is uncertain or conflicting, " +
      "and whether fetching a specific page with webFetch would help. " +
      "One short paragraph."
    ),
  suggested_reads: z
    .array(
      z.object({
        url: z.string().catch("").describe("Full URL the main agent could webFetch."),
        title: z.string().catch("").describe("Page title or short label."),
        reason: z.string().catch("").describe("One line: why this page is worth reading."),
      }),
    )
    .max(3)
    .catch([])
    .describe(
      "Pages the main agent might open with webFetch for deeper reading. " +
      "Leave empty if no single page adds value beyond your answer."
    ),
});

type SearchReport = z.infer<typeof searchReportInputSchema>;

/** The search report the research agent returns to the main agent. */
const searchReportSchema = tool({
  description:
    "Report your search findings with a recommendation for the main agent. " +
    "Call this ONCE after you have enough context from web_search rounds.",
  inputSchema: searchReportInputSchema,
});

/** Total model steps for the search loop: search rounds + the final report. */
const MAX_SEARCH_STEPS = 6;

/**
 * The research sub-agent's static role block — the system prompt is
 * `buildSubAgentSystem(SEARCH_ROLE)` (shared static base + this block), so
 * every search call shares one prefix for provider prompt caches. The
 * per-call `Today is …` date anchor and the query live in the user prompt.
 */
const SEARCH_ROLE = `You are a research assistant: search the web and report back to the main agent.

Role: the main agent is the referee; you are the video assistant (VAR). You do the searching and the watching, then you advise — you do not act on the results yourself, and you never read full pages (that is webFetch's job on the main agent's side).

Process:
1. Use web_search to find information relevant to the query in the user message. Search as many rounds as you need (up to ${MAX_SEARCHES_PER_QUERY}).
2. When you have enough, call searchReport with:
   - answer: the cited answer (ground every claim in what you actually found; mention the source; answer in the query's language — it reaches the user, so it overrides the shared base's English default).
   - recommendation: what the main agent should do with these results — which sources look strongest, what is uncertain or conflicting, and whether fetching a specific page with webFetch would help.
   - suggested_reads: 0-3 URLs the main agent might webFetch for deeper reading.`;

/** Wall-clock budget for one search run (runner SDK timeout + backstop). */
const SEARCH_TIMEOUT_MS = 60_000;

/**
 * Adapter #1: DeepSeek V4 Flash native search. Flash decides what to search
 * and how many rounds (up to MAX_SEARCHES_PER_QUERY), reads results on
 * DeepSeek's servers, and returns a cited digest — we run no search
 * infrastructure and need no extra API key.
 *
 * The research agent plays the VAR role: it searches (web_search is
 * provider-executed on DeepSeek's side), then reports a cited answer + advice
 * (searchReport, structured). It never fetches raw pages itself — deep reads
 * are the main agent's webFetch job.
 *
 * Runs on the unified sub-agent runner with a PRE-BUILT model — the DeepSeek
 * Anthropic-compatible endpoint and its normalizing fetch are unchanged.
 * `progress` routes each tool start (each web_search round, then the
 * searchReport) onto the shared data-tool-progress channel as a live
 * "Searching round N…" subtitle. This is SHELL streaming — the actual answer
 * text is not streamed (it's produced inside the structured searchReport tool
 * call), and the web_search execution itself is a DeepSeek-server black box.
 *
 * Error contract: the runner never throws, so any failed run (timeout
 * included) is re-thrown here as a plain Error carrying the runner's message —
 * webSearchExecute's withStepTimeout/triage layer keeps classifying transient
 * failures (step retry) vs deterministic ones (error tool result).
 */
export async function searchViaFlash(
  query: string,
  progress?: SubAgentProgressRef,
): Promise<WebSearchResult> {
  const provider = createAnthropic({
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY,
    fetch: normalizingFetch,
  });

  const today = new Date().toISOString().slice(0, 10);
  let searchRounds = 0;
  const res = await runSubAgent<SearchReport>({
    languageModel: provider("deepseek-v4-flash"),
    // The pre-built model speaks the Anthropic protocol — the effort mapping
    // must use the Anthropic provider-options shape, not DeepSeek's.
    effortSdk: "anthropic",
    system: buildSubAgentSystem(SEARCH_ROLE),
    prompt: `Today is ${today}.\n\nQuery: ${query}`,
    tools: {
      web_search: provider.tools.webSearch_20260209({
        maxUses: MAX_SEARCHES_PER_QUERY,
      }),
      searchReport: searchReportSchema,
    },
    toolChoice: "auto",
    reportToolName: "searchReport",
    reportSchema: searchReportInputSchema,
    maxSteps: MAX_SEARCH_STEPS,
    timeoutMs: SEARCH_TIMEOUT_MS,
    progress,
    onToolProgress: ({ toolName }) => {
      if (toolName === "web_search") {
        searchRounds += 1;
        return {
          line: `Searching the web (round ${searchRounds})…`,
          stage: "running",
        };
      }
      if (toolName === "searchReport") {
        return { line: "Compiling search report…", stage: "running" };
      }
      return undefined;
    },
  });

  if (!res.ok) {
    throw new Error(res.error ?? "Web search failed");
  }

  const sources = (res.sources ?? [])
    .filter(
      (s): s is typeof s & { sourceType: "url"; url: string } =>
        s.sourceType === "url" && typeof s.url === "string"
    )
    .map((s) => ({ title: s.title ?? s.url, url: s.url }));

  const report = res.report;
  if (report) {
    return {
      answer: report.answer ?? res.text ?? "",
      recommendation: report.recommendation ?? "",
      suggestedReads: (report.suggested_reads ?? [])
        .filter((s) => typeof s?.url === "string" && s.url.length > 0)
        .slice(0, 3)
        .map((s) => ({
          url: s.url as string,
          title: typeof s.title === "string" ? s.title : (s.url as string),
          reason: typeof s.reason === "string" ? s.reason : "",
        })),
      sources,
    };
  }

  // searchReport not called — fall back to the free-text answer.
  console.warn(
    "[WebSearch] searchReport not called. Final text:",
    res.text?.slice(0, 200) ?? "(no text)",
  );
  return {
    answer: res.text ?? "",
    recommendation: "",
    suggestedReads: [],
    sources,
  };
}

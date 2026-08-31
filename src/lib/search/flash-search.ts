/**
 * Web research — provider adapters behind a neutral contract.
 *
 * The webSearch tool's interface (query in → answer + sources + researcher's
 * confidence/controversies out) is OURS; nothing DeepSeek- or
 * Anthropic-shaped may leak out of this module. Today there is one adapter:
 * DeepSeek V4 Flash's native server-side search, reached through DeepSeek's
 * Anthropic-compatible endpoint (the OpenAI-compatible /v1 endpoint cannot
 * express provider-executed tools). Future adapters (Claude native webSearch,
 * Tavily for keyless demo) drop in behind the same contract and MUST also
 * produce the `recommendation` field.
 *
 * The search sub-agent is an independent RESEARCHER (v1.0): it searches
 * (web_search, provider-executed on DeepSeek's servers), then reads the most
 * promising pages ITSELF with its own quota-bounded `webFetch` tool
 * (implemented in-module via fetch-utils + the Document Segment Read
 * helpers), and synthesizes a real answer that combines the found material
 * with its own knowledge — web claims always carry a source mention.
 *
 * DeepSeek adapter specifics (not the contract — just this adapter):
 * - `web_search` is executed on DeepSeek's servers, which ingest the full
 *   page content during inference; the caller only ever sees the model's
 *   synthesized answer + citation URLs. The sub-agent's own `webFetch` closes
 *   the depth gap: pages that matter get read directly, on our side.
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
 * protocol), a 50-step cap, and a 150s wall-clock budget. The provider path
 * is unchanged: the runner receives a PRE-BUILT model instance so the custom
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
import {
  fetchWithGuard,
  extractText,
  isPrivateHost,
} from "@/lib/search/fetch-utils";
import {
  splitParagraphs,
  segmentSearch,
  textLines,
  searchResultToString,
} from "@/lib/retrieval/doc-segments";
import { capPlaybook } from "@/lib/evolution/store";

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
  /** The researcher's confidence and open controversies: what is solid, what
   *  is uncertain or conflicting between sources. Part of the neutral
   *  contract. */
  recommendation: string;
  /** Pages worth a follow-up look (the main agent's own verification, or a
   *  link to hand the user). */
  suggestedReads: Array<{ url: string; title: string; reason: string }>;
}

/** Server-side search rounds Flash may use per query. */
const MAX_SEARCHES_PER_QUERY = 3;

/** Pages the researcher may read in full per run. Reading pages is the
 *  expensive leg (fetch + context); a model that keeps "just one more page"
 *  would burn the whole step budget on reading. After the quota, webFetch
 *  returns a note and the researcher synthesizes from what it has. */
export const MAX_PAGE_READS = 6;

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_CHARS = 15_000;

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

// ─── Researcher tool: webFetch (in-module) ──────────────────────────────
//
// Mirrors webFetchExecute in tool-executors.ts (same SSRF guard, same
// Document Segment Read protocol) but as a PLAIN function — the whole
// research run already lives inside one step (webSearchExecute), so the
// page read must not become a step of its own.

/** Range filter for the researcher's webFetch — keyword search (misses
 *  degrade to the full text with a note) or a 1-indexed line range. */
type PageReadRange = {
  type: "search" | "lines";
  keywords?: string[];
  context?: number;
  start?: number;
  end?: number;
};

async function readPageImpl(url: string, range?: PageReadRange): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "ERROR: Invalid URL. Pass a full absolute URL, e.g. 'https://example.com/article'.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "ERROR: Unsupported URL protocol. Only http:// and https:// are allowed.";
  }
  if (isPrivateHost(parsed.hostname)) {
    return "ERROR: Cannot fetch local or private network addresses.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchWithGuard(parsed.toString(), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return `ERROR: HTTP ${res.status} ${res.statusText}`;
    }
    const text = await res.text();
    const extracted = extractText(text);

    // Document Segment Read protocol — applied before truncation so a matched
    // subset or line range is returned in full, not capped by the 15K fallback.
    if (range) {
      if (range.type === "search") {
        const keywords = range.keywords ?? [];
        const context = range.context ?? 1;
        const hits = segmentSearch(splitParagraphs(extracted), keywords, context, context);
        return searchResultToString(parsed.hostname + parsed.pathname, keywords, hits, extracted);
      }
      if (range.type === "lines") {
        const { content, clamped } = textLines(extracted, range.start ?? 1, range.end ?? 1);
        if (content === "" && (range.start ?? 1) > (range.end ?? 1)) {
          return `ERROR: Invalid line range ${range.start}-${range.end} for ${parsed.hostname}.`;
        }
        const header = `Lines ${range.start}-${range.end} of ${parsed.hostname}${clamped ? " (clamped)" : ""}:\n\n`;
        return content === "" ? `${header}(empty range)` : header + content;
      }
    }

    if (extracted.length > WEB_FETCH_MAX_CHARS) {
      return (
        extracted.slice(0, WEB_FETCH_MAX_CHARS) +
        `\n\n(Truncated at ${WEB_FETCH_MAX_CHARS} characters)`
      );
    }
    return extracted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `ERROR: Could not fetch URL: ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Structured output schema: searchReport ───────────────────────

/** Zod input schema — also the runner's report-validation schema. */
const searchReportInputSchema = z.object({
  answer: z
    .string()
    .catch("")
    .describe("Concise cited answer (2-5 paragraphs), grounded in what you actually found and read."),
  recommendation: z
    .string()
    .catch("")
    .describe(
      "Your researcher's assessment: how confident you are in the answer, " +
      "what is solid (and why), and what remains uncertain or conflicting " +
      "between sources. One short paragraph."
    ),
  suggested_reads: z
    .array(
      z.object({
        url: z.string().catch("").describe("Full URL worth a follow-up look."),
        title: z.string().catch("").describe("Page title or short label."),
        reason: z.string().catch("").describe("One line: why this page is worth reading."),
      }),
    )
    .max(3)
    .catch([])
    .describe(
      "0-3 pages worth a follow-up look — for the main agent's own " +
      "verification, or to hand the user as further reading. Leave empty if " +
      "no single page adds value beyond your answer."
    ),
});

type SearchReport = z.infer<typeof searchReportInputSchema>;

/** The search report the researcher returns to the main agent. */
const searchReportSchema = tool({
  description:
    "Report your research findings to your colleague. " +
    "Call this ONCE after you have searched and read enough to answer.",
  inputSchema: searchReportInputSchema,
});

/** Total model steps for the research loop: search rounds + page reads + the
 *  final report. */
const MAX_SEARCH_STEPS = 50;

/**
 * The research sub-agent's static role block — the system prompt is
 * `buildSubAgentSystem(SEARCH_ROLE)` (shared static base + this block), so
 * every search call shares one prefix for provider prompt caches. The
 * per-call `Today is …` date anchor and the query live in the user prompt.
 */
const SEARCH_ROLE = `You are an independent researcher: the main agent hands you a topic, and you come back with a real answer.

You both search AND read. web_search (provider-executed) finds the material; webFetch reads the most promising pages yourself — the search digest alone is often too thin to answer well. Pages come back as Markdown (headings, lists, links and tables preserved). You may read at most ${MAX_PAGE_READS} pages per run — spend them on the strongest sources.

Process:
1. Use web_search to find information relevant to the query in the user message (up to ${MAX_SEARCHES_PER_QUERY} rounds).
2. Read the most promising pages with webFetch (use its range filters to keep reads focused).
3. When you have enough, call searchReport with:
   - answer: a real answer to the query (2-5 paragraphs), synthesizing what you found with your own knowledge. Every claim that comes from the web must mention its source. Answer in the query's language — it reaches the user, so it overrides the shared base's English default.
   - recommendation: your researcher's assessment — how confident you are, what is solid, what is uncertain or conflicting between sources.
   - suggested_reads: 0-3 pages worth a follow-up look (your colleague's own verification, or further reading for the user).

Distinguish what the sources SAY from what YOU know — never blend the two silently. If the search found nothing usable, say so plainly in the answer instead of papering over it.`;

/** Wall-clock budget for one research run (runner SDK timeout + backstop). */
export const SEARCH_TIMEOUT_MS = 150_000;

/**
 * Adapter #1: DeepSeek V4 Flash native search. Flash decides what to search
 * and how many rounds (up to MAX_SEARCHES_PER_QUERY), reads results on
 * DeepSeek's servers, and returns a cited digest — we run no search
 * infrastructure and need no extra API key.
 *
 * The researcher searches (web_search is provider-executed on DeepSeek's
 * side), reads the strongest pages itself (webFetch, quota-bounded,
 * implemented in-module above), then reports a cited answer + its confidence
 * assessment (searchReport, structured).
 *
 * Runs on the unified sub-agent runner with a PRE-BUILT model — the DeepSeek
 * Anthropic-compatible endpoint and its normalizing fetch are unchanged.
 * `progress` routes each tool start (each web_search round, each page read,
 * then the searchReport) onto the shared data-tool-progress channel as a live
 * "Searching round N…" / "Reading page …" subtitle. This is SHELL streaming —
 * the actual answer text is not streamed (it's produced inside the structured
 * searchReport tool call), and the web_search execution itself is a
 * DeepSeek-server black box.
 *
 * `playbook` is the evolved researcher playbook (memory/agent-playbooks/
 * search.md, design v1.0 §2.4) — appended to the USER prompt, never the static
 * system prompt, so the shared prefix cache is untouched. Absent → no block.
 *
 * Error contract: the runner never throws, so any failed run (timeout
 * included) is re-thrown here as a plain Error carrying the runner's message —
 * webSearchExecute's withStepTimeout/triage layer keeps classifying transient
 * failures (step retry) vs deterministic ones (error tool result).
 */
export async function searchViaFlash(
  query: string,
  progress?: SubAgentProgressRef,
  playbook?: string,
): Promise<WebSearchResult> {
  const provider = createAnthropic({
    baseURL: "https://api.deepseek.com/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY,
    fetch: normalizingFetch,
  });

  const today = new Date().toISOString().slice(0, 10);
  // Evolved working notes (design v1.0 §2.4) — appended to the USER prompt so
  // the static system prompt (and its prefix cache) never changes. Capped so a
  // bloated playbook cannot flood the prompt; absent playbook → no block.
  const playbookBlock = playbook?.trim()
    ? `\n\nEvolved working notes (your researcher playbook — follow these unless they conflict with the query):\n${capPlaybook(playbook.trim())}`
    : "";
  let searchRounds = 0;
  // Per-run page-read quota (see MAX_PAGE_READS).
  let pageReads = 0;
  const res = await runSubAgent<SearchReport>({
    languageModel: provider("deepseek-v4-flash"),
    // The pre-built model speaks the Anthropic protocol — the effort mapping
    // must use the Anthropic provider-options shape, not DeepSeek's.
    effortSdk: "anthropic",
    system: buildSubAgentSystem(SEARCH_ROLE),
    prompt: `Today is ${today}.\n\nQuery: ${query}${playbookBlock}`,
    tools: {
      web_search: provider.tools.webSearch_20260209({
        maxUses: MAX_SEARCHES_PER_QUERY,
      }),
      webFetch: tool({
        description:
          "Fetch and read a specific page as Markdown (headings/lists/links/" +
          "tables preserved, boilerplate stripped, up to ~15K characters). " +
          `Costs one of your ${MAX_PAGE_READS} ` +
          "page-read slots — spend them on the strongest sources only. " +
          "Optional `range`: `search` matches keywords across the page " +
          "(misses return the full text with a note); `lines` reads a " +
          "1-indexed line range.",
        inputSchema: z.object({
          url: z
            .string()
            .describe("The full URL to fetch, e.g. 'https://example.com/article'."),
          range: z
            .object({
              type: z
                .enum(["search", "lines"])
                .describe(
                  "search = keyword match, returns matching paragraphs (+ context); " +
                  "if nothing matches, returns the full page text with a note. " +
                  "lines = 1-indexed line range of the extracted text.",
                ),
              keywords: z
                .array(z.string())
                .optional()
                .describe("Case-insensitive keywords to match. Only for type 'search'."),
              context: z
                .number()
                .optional()
                .describe("Paragraphs of context around each match (default 1). Only for type 'search'."),
              start: z
                .number()
                .optional()
                .describe("First line (1-indexed, inclusive). Only for type 'lines'."),
              end: z
                .number()
                .optional()
                .describe("Last line (1-indexed, inclusive). Only for type 'lines'."),
            })
            .optional()
            .describe("Optional selective read. When omitted, returns the full extracted text."),
        }),
        execute: async ({ url, range }: { url: string; range?: PageReadRange }) => {
          if (pageReads >= MAX_PAGE_READS) {
            return (
              `(Page-read quota exhausted — ${MAX_PAGE_READS} reads per run.) ` +
              "Answer from what you have already searched and read."
            );
          }
          pageReads += 1;
          return readPageImpl(url, range);
        },
      }),
      searchReport: searchReportSchema,
    },
    toolChoice: "auto",
    reportToolName: "searchReport",
    reportSchema: searchReportInputSchema,
    maxSteps: MAX_SEARCH_STEPS,
    timeoutMs: SEARCH_TIMEOUT_MS,
    progress,
    onToolProgress: ({ toolName, input: toolInput }) => {
      if (toolName === "web_search") {
        searchRounds += 1;
        return {
          line: `Searching the web (round ${searchRounds})…`,
          stage: "running",
        };
      }
      if (toolName === "webFetch") {
        const url =
          typeof toolInput === "object" && toolInput !== null && "url" in toolInput
            ? String((toolInput as { url?: unknown }).url ?? "")
            : "";
        let host = url;
        try {
          host = new URL(url).hostname;
        } catch {
          /* keep the raw url as the label */
        }
        return {
          line: host ? `Reading page ${host}…` : "Reading a page…",
          stage: "running",
        };
      }
      if (toolName === "searchReport") {
        return { line: "Compiling the research report…", stage: "running" };
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

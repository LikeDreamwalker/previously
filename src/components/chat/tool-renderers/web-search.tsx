"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";
import { MarkdownRenderer } from "../markdown";

interface WebSearchRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
  /** Live progress from `data-tool-progress` — the streaming subtitle. */
  streamingText?: string;
  /** Progress stage from `data-tool-progress` (unused — search status stays dim). */
  streamingStage?: string;
}

interface WebSearchOutput {
  answer?: string;
  sources?: Array<{ title?: string; url?: string }>;
  error?: string;
  recommendation?: string;
  suggestedReads?: Array<{ url: string; title?: string; reason?: string }>;
}

function resolveName(
  input: Record<string, unknown> | undefined,
  output: WebSearchOutput | undefined,
  running: boolean,
  t: ReturnType<typeof useTranslations>,
): string {
  const query =
    typeof input?.query === "string" ? input.query : "";
  const sourceCount = Array.isArray(output?.sources) ? output.sources.length : 0;

  if (running) {
    return query
      ? t("webSearchRunning", { query })
      : t("webSearchRunning", { query: "…" });
  }
  return query
    ? t("webSearchDone", { query, count: sourceCount })
    : t("webSearchDone", { query: "…", count: sourceCount });
}

/**
 * webSearch tool: Globe icon, the query as the label, and the cited answer +
 * source links in the expanded view. PhaseIndicator in streaming mode — the
 * running label plus a "Searching…" subtitle while it works; the subtitle fades
 * on completion and clicking expands the sources.
 */
export function WebSearchRenderer({
  toolName: _toolName,
  input,
  output,
  state,
  streamingText,
  streamingStage: _streamingStage,
}: WebSearchRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const query =
    typeof inp?.query === "string" ? inp.query : null;

  const out = output as WebSearchOutput | undefined;
  const sources = Array.isArray(out?.sources)
    ? out.sources.filter((s): s is { title: string; url: string } => typeof s?.url === "string")
    : [];
  const recommendation =
    typeof out?.recommendation === "string" && out.recommendation.trim()
      ? out.recommendation
      : null;
  const suggestedReads = Array.isArray(out?.suggestedReads)
    ? out.suggestedReads.filter(
        (s): s is { url: string; title: string; reason: string } =>
          typeof s?.url === "string",
      )
    : [];

  const displayName = resolveName(inp, out, state.running, t);

  const expandedContent = out ? (
    out.error ? (
      <p className="text-destructive">{out.error}</p>
    ) : (
      <div className="space-y-2">
        {out.answer ? <MarkdownRenderer content={out.answer} /> : null}
        {recommendation && (
          <div className="rounded-md border border-border/40 bg-muted/30 px-3 py-2">
            <p className="mb-1 text-xs font-semibold text-foreground/80">
              {t("webSearchRecommendation")}
            </p>
            <MarkdownRenderer content={recommendation} />
          </div>
        )}
        {sources.length > 0 ? (
          <ul
            className={
              out.answer
                ? "space-y-1 border-t border-border pt-2"
                : "space-y-1"
            }
          >
            {sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">[{i + 1}]</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-brand underline underline-offset-2"
                >
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {suggestedReads.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-foreground/80">
              {t("webSearchSuggestedReads")}
            </p>
            <ul className="space-y-1">
              {suggestedReads.map((s, i) => (
                <li key={i} className="flex flex-col text-xs">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-brand underline underline-offset-2"
                  >
                    {s.title || s.url}
                  </a>
                  {s.reason && (
                    <span className="text-muted-foreground">{s.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  ) : undefined;

  // Surface a search failure through the PhaseIndicator error state.
  const displayState: ToolRenderState = {
    ...state,
    error: state.error ?? (out?.error ?? undefined),
  };

  return (
    <PhaseIndicator
      mode="streaming"
      icon={<Globe className="h-3.5 w-3.5" />}
      label={displayName}
      state={displayState}
      streamingText={streamingText}
      expandedContent={expandedContent}
    />
  );
}

"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";

interface RecallToolRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
}

interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
  key_turns?: number[];
}

interface RecallOutput {
  hits?: RecallHit[];
  rawContents?: Record<string, string>;
  confidence?: number;
  reasoning?: string;
}

function resolveLabel(
  input: Record<string, unknown> | undefined,
  output: RecallOutput | undefined,
  running: boolean,
  t: ReturnType<typeof useTranslations>,
): string {
  const query = typeof input?.query === "string" ? input.query : "";
  const hitCount = Array.isArray(output?.hits) ? output.hits.length : 0;

  if (running) {
    return query
      ? t("recallRunning", { query })
      : t("recallRunning", { query: "…" });
  }
  return query
    ? t("recallDone", { query, count: hitCount })
    : t("recallDone", { query: "…", count: hitCount });
}

/**
 * Recall tool renderer using PhaseIndicator in static mode.
 *
 * Recall is a tool in the data model (tool-call → tool-result), but it is
 * rendered with the same PhaseIndicator container as thinking — giving it
 * phase-level visual weight while staying a fully manual expand/collapse.
 */
export function RecallToolRenderer({
  toolName: _toolName,
  input,
  output,
  state,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const query = typeof inp?.query === "string" ? inp.query : "";

  const out = output as RecallOutput | undefined;
  const hits = Array.isArray(out?.hits) ? out.hits : [];
  const rawContents = out?.rawContents ?? {};
  const confidence = typeof out?.confidence === "number" ? out.confidence : null;
  const reasoning = typeof out?.reasoning === "string" ? out.reasoning : "";

  const hasHits = hits.length > 0;
  const isRunning = state.running;

  const label = resolveLabel(inp, out, isRunning, t);

  // Summary for the header (only when not running)
  const summary = isRunning
    ? undefined
    : hasHits
      ? t("recallHits", { count: hits.length })
      : t("recallNone");

  // Meta: confidence (only when finished with hits)
  const meta =
    !isRunning && confidence !== null
      ? `${Math.round(confidence * 100)}%`
      : undefined;

  // Expanded content
  const expandedContent = hasHits ? (
    <div className="space-y-3">
      {/* Reasoning */}
      {reasoning && (
        <p className="text-xs leading-relaxed text-muted-foreground italic">
          {reasoning}
        </p>
      )}

      {/* Hits */}
      <div className="space-y-1.5">
        {hits.map((hit, i) => (
          <div
            key={i}
            className="border-b border-border/30 pb-2 last:border-0 last:pb-0"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {hit.slice_id}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {Math.round(hit.relevance * 100)}%
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {hit.reason}
            </p>
            {hit.key_turns && hit.key_turns.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Key turns: {hit.key_turns.join(", ")}
              </p>
            )}
            {/* Raw content for this slice */}
            {rawContents[hit.slice_id] && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
                  Raw content
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {rawContents[hit.slice_id]}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>

      {/* Confidence */}
      {confidence !== null && (
        <p className="text-xs text-muted-foreground">
          Confidence: {Math.round(confidence * 100)}%
        </p>
      )}
    </div>
  ) : reasoning ? (
    <p className="text-xs leading-relaxed text-muted-foreground">{reasoning}</p>
  ) : undefined;

  return (
    <PhaseIndicator
      mode="static"
      icon={<History className="h-3.5 w-3.5" />}
      label={label}
      summary={summary}
      meta={meta}
      state={state}
      expandedContent={expandedContent}
    />
  );
}

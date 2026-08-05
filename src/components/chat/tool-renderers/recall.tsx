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
  /** Live progress from `data-tool-progress` — the streaming subtitle. */
  streamingText?: string;
  /** Progress stage from `data-tool-progress` (unused — recall status stays dim). */
  streamingStage?: string;
}

interface RecallHit {
  slice_id: string;
  relevance: number;
  reason: string;
  key_turns?: number[];
}

interface RecallOutput {
  hits?: RecallHit[];
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
 * Recall tool renderer using PhaseIndicator in streaming mode.
 *
 * Recall returns neutral pointers only — slice IDs, relevance, reasons,
 * key turn numbers. No raw content is returned; Pro uses readSlice
 * (with optional range) to fetch content from slices it actually needs.
 * Streaming mode gives it a running label + "Scanning…" subtitle while it
 * works; the subtitle fades and clicking expands the pointers.
 */
export function RecallToolRenderer({
  toolName: _toolName,
  input,
  output,
  state,
  streamingText,
  streamingStage: _streamingStage,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;
  const query = typeof inp?.query === "string" ? inp.query : "";

  const out = output as RecallOutput | undefined;
  const hits = Array.isArray(out?.hits) ? out.hits : [];
  const confidence = typeof out?.confidence === "number" ? out.confidence : null;
  const reasoning = typeof out?.reasoning === "string" ? out.reasoning : "";

  const hasHits = hits.length > 0;
  const isRunning = state.running;

  const label = resolveLabel(inp, out, isRunning, t);

  // Expanded content — hits list only, no raw content
  const expandedContent = hasHits ? (
    <div className="space-y-3">
      {/* Reasoning */}
      {reasoning && (
        <p className="text-xs leading-relaxed text-muted-foreground italic">
          {reasoning}
        </p>
      )}

      {/* Hits — pointers only */}
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
      mode="streaming"
      icon={<History className="h-3.5 w-3.5" />}
      label={label}
      state={state}
      streamingText={streamingText}
      expandedContent={expandedContent}
    />
  );
}

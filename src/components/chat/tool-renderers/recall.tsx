"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";
import { MarkdownRenderer } from "../markdown";
import { progressStageTone } from "@/lib/chat/build-stream";

interface RecallToolRendererProps {
  toolName: string;
  input?: unknown;
  output?: unknown;
  state: ToolRenderState;
  /** Live progress from `data-tool-progress` — the streaming subtitle. */
  streamingText?: string;
  /** Progress stage — "running" (recalling) vs "thinking"/"done" (sub-agent steps). */
  streamingStage?: string;
}

interface RecallReference {
  slice_id: string;
  quote: string;
  note?: string;
}

interface RecallOutput {
  answer?: string;
  references?: RecallReference[];
  searched?: string[];
  confidence?: number;
  note?: string;
}

function resolveLabel(
  input: Record<string, unknown> | undefined,
  output: RecallOutput | undefined,
  running: boolean,
  t: ReturnType<typeof useTranslations>,
): string {
  const question =
    typeof input?.question === "string" ? input.question : "";
  const refCount = Array.isArray(output?.references)
    ? output.references.length
    : 0;

  if (running) {
    return question
      ? t("recallRunning", { query: question })
      : t("recallRunning", { query: "…" });
  }
  return question
    ? t("recallDone", { query: question, count: refCount })
    : t("recallDone", { query: "…", count: refCount });
}

/**
 * Recall tool renderer using PhaseIndicator in streaming mode.
 *
 * Recall is the episodic-recall colleague (v1.0): it answers the main agent's
 * question in natural language, with every situational claim anchored to a
 * verbatim quote + slice id in `references`, plus the `searched` trail it
 * walked. Streaming mode gives it a running label + live exploration subtitle
 * while it works; clicking expands the answer and its evidence.
 */
export function RecallToolRenderer({
  toolName: _toolName,
  input,
  output,
  state,
  streamingText,
  streamingStage,
}: RecallToolRendererProps) {
  const t = useTranslations("chat.tool");

  const inp = input as Record<string, unknown> | undefined;

  const out = output as RecallOutput | undefined;
  const answer = typeof out?.answer === "string" ? out.answer : "";
  const references = Array.isArray(out?.references) ? out.references : [];
  const searched = Array.isArray(out?.searched) ? out.searched : [];
  const confidence = typeof out?.confidence === "number" ? out.confidence : null;
  const note = typeof out?.note === "string" ? out.note : "";

  const isRunning = state.running;

  const label = resolveLabel(inp, out, isRunning, t);

  // Expanded content — the colleague's answer + its evidence trail.
  const expandedContent = out ? (
    <div className="space-y-3">
      {/* Answer */}
      {answer && <MarkdownRenderer content={answer} />}

      {/* References — the auditable evidence anchors */}
      {references.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-foreground/80">
            {t("recallReferences")}
          </p>
          <div className="space-y-1.5">
            {references.map((r, i) => (
              <div
                key={i}
                className="rounded-md border border-border/30 px-2 py-1.5"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {r.slice_id}
                </span>
                <blockquote className="mt-1 border-l-2 border-border/60 pl-2 text-xs leading-relaxed text-foreground/80 italic">
                  {r.quote}
                </blockquote>
                {r.note && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.note}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Searched trail — how complete this recall is */}
      {searched.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground/80">
            {t("recallSearched")}
          </p>
          <ul className="space-y-0.5">
            {searched.map((s, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confidence + the executor's definitive-empty note */}
      {confidence !== null && (
        <p className="text-xs text-muted-foreground">
          Confidence: {Math.round(confidence * 100)}%
        </p>
      )}
      {note && (
        <p className="text-xs leading-relaxed text-muted-foreground italic">
          {note}
        </p>
      )}
    </div>
  ) : undefined;

  return (
    <PhaseIndicator
      mode="streaming"
      className={
        isRunning ? "bg-brand-50/50 dark:bg-brand-500/[0.06]" : undefined
      }
      icon={<History className="h-3.5 w-3.5" />}
      label={label}
      state={state}
      streamingText={streamingText}
      subtitleTone={progressStageTone(streamingStage)}
      expandedContent={expandedContent}
    />
  );
}

"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { AlertTriangle, Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";
import { MarkdownRenderer } from "../markdown";

interface FragmentInput {
  question?: string;
  effort?: "low" | "medium" | "high";
}

interface FragmentOutput {
  ok?: boolean;
  status?: "completed" | "timeout" | "error";
  question?: string;
  answer?: string;
  reasoning?: string;
  error?: string;
  note?: string;
}

interface ThinkDeepToolRendererProps {
  /** Batch shape (current): `{ fragments: [...] }`. Legacy single: `{ question, effort }`. */
  input?: {
    fragments?: FragmentInput[];
    question?: string;
    effort?: FragmentInput["effort"];
  };
  output?: {
    fragments?: FragmentOutput[];
    ok?: boolean;
    status?: FragmentOutput["status"];
    answer?: string;
    reasoning?: string;
    error?: string;
    note?: string;
  };
  state: ToolRenderState;
  /** Live reasoning/answer line from `data-tool-progress` — the streaming subtitle. */
  streamingText?: string;
  /** Progress stage ("reasoning" | "writing") — drives subtitle tone (dim vs primary). */
  streamingStage?: string;
}

function effortLabelKey(
  effort: FragmentInput["effort"],
): "thinkEffortLow" | "thinkEffortMedium" | "thinkEffortHigh" | null {
  switch (effort) {
    case "medium":
      return "thinkEffortMedium";
    case "high":
      return "thinkEffortHigh";
    case "low":
      return "thinkEffortLow";
    default:
      return null;
  }
}

/**
 * One fragment's body — the captured thinking trail (collapsible), then the
 * written conclusion, or the interruption/failure reason.
 */
function FragmentBody({
  question,
  effort,
  result,
  showQuestion = true,
}: {
  question: string;
  effort?: FragmentInput["effort"];
  result?: FragmentOutput;
  showQuestion?: boolean;
}) {
  const t = useTranslations("chat.tool");

  const timedOut = result?.status === "timeout";
  const failed = result?.ok === false && !timedOut;
  const errorText = typeof result?.error === "string" ? result.error : null;
  const answer =
    typeof result?.answer === "string" && result.answer.trim()
      ? result.answer
      : null;
  const reasoning =
    typeof result?.reasoning === "string" && result.reasoning.trim()
      ? result.reasoning
      : null;
  const effortLabel = effortLabelKey(effort);
  const effortText = effortLabel ? t(effortLabel) : null;

  // The fragment's captured thinking trail — collapsible inside the card.
  const reasoningBlock = reasoning ? (
    <details className="rounded-md border border-muted/60 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
        {t("thinkReasoning")}
      </summary>
      <div className="mt-2 border-t border-muted/40 pt-2">
        <MarkdownRenderer content={reasoning} />
      </div>
    </details>
  ) : null;

  if (timedOut) {
    return (
      <div className="space-y-2">
        {reasoningBlock}
        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-500">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {t("thinkTimedOut")}
        </div>
        {answer ? (
          <MarkdownRenderer content={answer} />
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-amber-400">
            {errorText ?? t("thinkTimedOut")}
          </pre>
        )}
      </div>
    );
  }

  if (failed) {
    return (
      <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-red-400">
        {errorText ?? "Unknown error"}
      </pre>
    );
  }

  if (answer) {
    return (
      <div className="space-y-2">
        {reasoningBlock}
        <MarkdownRenderer content={answer} />
      </div>
    );
  }

  // Running (no output yet) — show the question and effort as placeholders.
  return (
    <div className="space-y-2 font-mono text-xs leading-relaxed text-muted-foreground">
      {showQuestion && question && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkQuestion")}
          </span>
          <span className="min-w-0 break-all">{question}</span>
        </div>
      )}
      {effortText && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-muted-foreground/70">
            {t("thinkEffort")}
          </span>
          <span className="min-w-0">{effortText}</span>
        </div>
      )}
    </div>
  );
}

/**
 * thinkDeep reasoning-fragment card — PhaseIndicator in streaming mode. The
 * batch runs ALL fragments in one step; while they run, a single-line
 * typewriter subtitle streams the live `[i/N]`-prefixed reasoning tail
 * (`data-tool-progress`). On completion the subtitle fades and clicking expands
 * every fragment's answer + captured thinking trail, or its failure reason.
 */
export function ThinkDeepToolRenderer({
  input,
  output,
  state,
  streamingText,
  streamingStage,
}: ThinkDeepToolRendererProps) {
  const t = useTranslations("chat.tool");

  const fragments = Array.isArray(input?.fragments) ? input.fragments : null;
  const fragmentOutputs = Array.isArray(output?.fragments)
    ? output.fragments
    : null;

  // Fold aggregate fragment outcomes into the SDK part state so PhaseIndicator
  // renders the right visual: amber interrupted if any fragment timed out, red
  // error if any failed.
  const anyTimeout =
    fragmentOutputs?.some((f) => f.status === "timeout") ?? false;
  const failedOutput = fragmentOutputs?.find(
    (f) => f.ok === false && f.status !== "timeout",
  );
  const displayState: ToolRenderState = {
    ...state,
    interrupted: state.interrupted || anyTimeout,
    error: state.error ?? (failedOutput?.error ?? undefined),
  };

  const subtitleTone: "thinking" | "answer" =
    streamingStage === "writing" ? "answer" : "thinking";

  // Batch: one block per fragment with the question as its header. Single
  // (legacy): reuse the original single-fragment layout.
  const expandedContent = fragments ? (
    <div className="space-y-3">
      {fragments.map((f, i) => (
        <div key={i} className="space-y-1">
          {fragments.length > 1 && f.question && (
            <div className="text-xs font-medium text-muted-foreground/90">
              {f.question}
            </div>
          )}
          <FragmentBody
            question={f.question ?? ""}
            effort={f.effort}
            result={fragmentOutputs?.[i]}
            showQuestion={fragments.length === 1}
          />
        </div>
      ))}
    </div>
  ) : (
    <FragmentBody
      question={input?.question ?? ""}
      effort={input?.effort}
      result={
        output
          ? {
              ok: output.ok,
              status: output.status,
              answer: output.answer,
              reasoning: output.reasoning,
              error: output.error,
              note: output.note,
            }
          : undefined
      }
    />
  );

  return (
    <PhaseIndicator
      mode="streaming"
      icon={<Brain className="h-3.5 w-3.5" />}
      label={t("thinkDeep")}
      state={displayState}
      streamingText={streamingText}
      subtitleTone={subtitleTone}
      expandedContent={expandedContent}
    />
  );
}

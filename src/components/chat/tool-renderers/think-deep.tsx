"use client";

import type { ToolRenderState } from "@/lib/chat/tool-state";
import { AlertTriangle, Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import { PhaseIndicator } from "../phase-indicator";
import { MarkdownRenderer } from "../markdown";
import { progressStageTone } from "@/lib/chat/build-stream";

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
  /** Progress stage ("running" | "thinking" | "writing" | "done") — drives subtitle tone. */
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

/** One fragment's independent indicator card. */
function FragmentCard({
  question,
  effort,
  result,
  isRunning,
  streamingText,
  subtitleTone,
  index,
}: {
  question: string;
  effort?: FragmentInput["effort"];
  result?: FragmentOutput;
  isRunning: boolean;
  streamingText?: string;
  subtitleTone: "thinking" | "answer";
  index: number;
}) {
  const t = useTranslations("chat.tool");

  const timedOut = result?.status === "timeout";
  const failed = result?.ok === false && !timedOut;
  const cardState: ToolRenderState = {
    running: isRunning,
    inputStreaming: false,
    interrupted: isRunning ? false : timedOut,
    denied: false,
    approvalRequested: false,
    isActiveApproval: false,
    error: !isRunning && failed ? (result?.error ?? undefined) : undefined,
  };

  return (
    <PhaseIndicator
      key={index}
      mode="streaming"
      className={
        isRunning ? "bg-brand-50/50 dark:bg-brand-500/[0.06]" : undefined
      }
      icon={<Brain className="h-3.5 w-3.5" />}
      label={
        isRunning
          ? t("thinkDeepRunning", { question: question || "…" })
          : t("thinkDeepDone", { question: question || "…" })
      }
      state={cardState}
      streamingText={streamingText}
      subtitleTone={subtitleTone}
      expandedContent={
        <FragmentBody
          question={question}
          effort={effort}
          result={result}
          showQuestion={false}
        />
      }
    />
  );
}

/**
 * thinkDeep renderer — one independent indicator card per thinkDeep call. Each
 * call is its own sub-agent: the label carries its question ("Reasoning about
 * …"), the live line streams its own reasoning, and on completion the card
 * settles independently with the conclusion + thinking trail, or its
 * timeout/failure reason.
 */
export function ThinkDeepToolRenderer({
  input,
  output,
  state,
  streamingText,
  streamingStage,
}: ThinkDeepToolRendererProps) {
  const t = useTranslations("chat.tool");
  const isRunning = state.running;
  const subtitleTone = progressStageTone(streamingStage);

  // The fragment list to render. Batch: one card per input fragment. Legacy
  // single: one card from the single-question fields.
  const fragments = Array.isArray(input?.fragments) ? input.fragments : null;
  const fragmentOutputs = Array.isArray(output?.fragments)
    ? output.fragments
    : null;
  const cards: Array<{
    question: string;
    effort?: FragmentInput["effort"];
    result?: FragmentOutput;
  }> = [];
  if (fragments) {
    for (let i = 0; i < fragments.length; i++) {
      cards.push({
        question: fragments[i]?.question ?? "",
        effort: fragments[i]?.effort,
        result: fragmentOutputs?.[i],
      });
    }
  } else {
    cards.push({
      question: input?.question ?? "",
      effort: input?.effort,
      result: output
        ? {
            ok: output.ok,
            status: output.status,
            answer: output.answer,
            reasoning: output.reasoning,
            error: output.error,
            note: output.note,
          }
        : undefined,
    });
  }

  return (
    <div className="space-y-1">
      {cards.map((card, i) => (
        <FragmentCard
          key={i}
          index={i}
          question={card.question}
          effort={card.effort}
          result={card.result}
          isRunning={isRunning}
          // Single-question calls stream their own line (no [i/N] prefix) on
          // the only card. Legacy batch messages (old replays) render N cards;
          // the live line shows on the first while the rest pulse.
          streamingText={i === 0 ? streamingText : undefined}
          subtitleTone={subtitleTone}
        />
      ))}
    </div>
  );
}

/**
 * Pure stream classifier for the chat UI — walks a UIMessage's parts in natural
 * order and produces the ordered list of renderable StreamItems.
 *
 * Extracted from chat-message.tsx so the classification logic is unit-testable
 * without a DOM. It is intentionally side-effect-free: given the same parts it
 * always returns the same items, which keeps the streaming UI deterministic and
 * lets reconnecting clients replay the same turn identically.
 */

export type AnyPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  data?: unknown;
  /**
   * Provider metadata survives stream → part assembly (unlike text block
   * ids). The bridge model marks its authoritative re-emitted answer block
   * with `providerMetadata["previously-bridge"].authoritative === true`.
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
  /** File parts (user attachments): data URL + media metadata. */
  mediaType?: string;
  url?: string;
  filename?: string;
};

/**
 * The `data-evolution` payload streamed during housekeeping — the inline card
 * evolution run (Previously Agent). Progress chunks carry
 * `{ status: "running", step, live?, liveStage? }` (`live` is the Previously
 * Agent's realtime thinking line); the terminal chunk carries the result
 * (changes / summary / note / mutations / error / partial) with
 * `status: "done"`.
 *
 * Backward compatibility: chunks streamed before the `status` field existed
 * carry `{ running: boolean, step? }` instead — `status` is then inferred
 * from `running`.
 */
export type EvolutionStepData = {
  /** Lifecycle status. Absent on legacy chunks — inferred from `running`. */
  status?: "running" | "done";
  /** Legacy running flag (pre-`status` chunks). */
  running?: boolean;
  /** Mid-run progress step: reading / reviewing / applied. */
  step?: string;
  /** The Previously Agent's realtime thinking line, streamed while running. */
  live?: string;
  /** Stage of the live line — drives the subtitle tone. */
  liveStage?: "thinking" | "writing";
  /** Card update counts: added = card rewritten, removed = stale Now items dropped. */
  changes?: {
    added: number;
    reinforced: number;
    demoted: number;
    removed: number;
    superseded: number;
  };
  hasChanges?: boolean;
  /** The review's reasoning — the expanded content. */
  note?: string;
  /** The agent's one-sentence user-language account of what changed — the
   *  headline when present (the abstract counts fall back). */
  summary?: string;
  /** The actual line-level card mutations — the expanded diff. */
  mutations?: Array<{ type: "added" | "removed"; text: string }>;
  error?: string;
  /** Set when the run was cut short — only part of the update was applied. */
  partial?: boolean;
};

/**
 * One sub-step inside the housekeeping card (slice / analyze / tags / context /
 * strands). Card evolution is NOT a sub-step — it is its own StreamItem
 * (see the "evolution" kind below).
 */
export type HousekeepingStep = {
  phase: string;
  running: boolean;
  summaries?: string[];
};

/**
 * One row of the bridge-tool indicator — a protocol-2 tool-activity event from
 * the local CLI (mirrors BridgeEvent in src/lib/bridge.ts; declared
 * structurally so this pure module stays server-free).
 */
export type BridgeToolRow = {
  name: string;
  summary: string;
  status: "start" | "ok" | "error";
};

export type StreamItem =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; content: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      state: string;
      input?: unknown;
      output?: unknown;
      /** Live progress from `data-tool-progress` chunks — the streaming subtitle. */
      streamingText?: string;
      /** Progress stage ("running" | "thinking" | "writing" | "done") — drives subtitle tone. */
      streamingStage?: string;
    }
  | { kind: "housekeeping"; steps: HousekeepingStep[] }
  | {
      kind: "evolution";
      /** Normalized lifecycle flag — derived from `status`, or legacy `running`. */
      running: boolean;
      /** The latest data-evolution chunk's payload (last chunk wins). */
      data: EvolutionStepData;
    }
  | {
      /** The bridge activity indicator (client+bridge mode): one row per
       *  CLI tool event. Carried by data-phase chunks whose data carries a
       *  `tools` array (chat phase "stageWorking" / housekeeping phase
       *  "bridgeHousekeeping"); frames are cumulative, last chunk wins. */
      kind: "bridge-tools";
      phase: string;
      running: boolean;
      tools: BridgeToolRow[];
      /** The CLI's rolling narration line (housekeeping deltas) — last
       *  frame wins; shown only while running. */
      live?: string;
      /** Client-mode housekeeping only: the deterministic wrap-up rows
       *  (slice / analyze / tags / context / strands) filling in as the
       *  engineering steps complete around the single bridge call. Renders
       *  as a checklist inside the bridge housekeeping card. */
      steps?: HousekeepingStep[];
      /** Client-mode housekeeping only: set when the bridge call failed and
       *  the turn degraded to the deterministic path — the card shows an
       *  amber warning instead of settling silently green. */
      warning?: string;
    }
  | {
      kind: "phase";
      phase: string;
      running?: boolean;
      mode?: string;
      summaries?: string[];
      compact?: boolean;
    };

/** The agent's coarse current activity while streaming. */
export type AgentStage = "recalling" | "reasoning" | "working" | "composing";

/**
 * Maps a tool-progress stage to the streaming subtitle tone. `writing` / `done`
 * read as the settled answer (brand, normal weight); anything else (running /
 * thinking / legacy reasoning) reads as in-progress (mono muted).
 */
export function progressStageTone(stage?: string): "thinking" | "answer" {
  return stage === "writing" || stage === "done" ? "answer" : "thinking";
}

/** Memory-related tools — while they run, the stage reads as "recalling". */
function isRecallTool(toolName: string): boolean {
  return (
    toolName === "recall" ||
    toolName.startsWith("read") ||
    toolName === "listSlices" ||
    toolName === "listStrands"
  );
}

/**
 * The agent's coarse current activity while streaming, derived from the raw
 * part stream (last significant part wins). Returns null during housekeeping
 * (before any reasoning/tool/text), so the UI can show the prep card instead
 * of a stage pill.
 */
export function deriveAgentStage(parts: readonly AnyPart[]): AgentStage | null {
  let stage: AgentStage | null = null;
  for (const p of parts) {
    if (p.type === "reasoning") {
      stage = "reasoning";
    } else if (p.type === "text") {
      stage = "composing";
    } else if (p.type === "data-phase") {
      // Bridge mode: the chat answer's activity frames (phase "stageWorking")
      // are the only in-flight signal — light the pill while the CLI works.
      // Housekeeping frames ("bridgeHousekeeping" / compact sub-steps) are
      // ignored: the prep card is showing, same as normal mode.
      const d = p.data as { phase?: string; running?: boolean } | undefined;
      if (d?.phase === "stageWorking") {
        stage = d.running === false ? null : "working";
      }
    } else if (p.type === "data-tool-progress") {
      const toolName = (p.data as { toolName?: string } | undefined)?.toolName;
      if (toolName) stage = isRecallTool(toolName) ? "recalling" : "working";
    } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      const toolName = p.toolName ?? p.type.replace("tool-", "");
      stage = isRecallTool(toolName) ? "recalling" : "working";
    }
  }
  return stage;
}

/**
 * Classifies a message's parts into renderable StreamItems in natural order.
 *
 * The consecutive `compact` housekeeping phases (slice / analyze / tags /
 * context / strands) are merged into ONE `housekeeping` item with a running
 * checklist, while `data-evolution` chunks become their OWN `evolution` item
 * at the position they arrive (between the context and strands phases) —
 * the wire format stays untouched (reconnect replay is unaffected); only the
 * client presentation groups them.
 */
export function buildStream(
  parts: readonly AnyPart[],
  _isStreaming: boolean,
): StreamItem[] {
  const items: StreamItem[] = [];
  let textBuf: string[] = [];
  // Progress chunks that arrived before their tool-* part (the tool-executor
  // writes mid-step; the tool part can surface a tick later). Applied when the
  // tool item is created.
  const pendingProgress = new Map<string, string>();

  const flushText = () => {
    if (textBuf.length > 0) {
      items.push({ kind: "text", content: textBuf.join("") });
      textBuf = [];
    }
  };

  /** The single housekeeping card — compact phases merge into it by phase name. */
  let housekeeping: Extract<StreamItem, { kind: "housekeeping" }> | null = null;
  const upsertHousekeepingStep = (
    phase: string,
    running: boolean,
    summaries?: string[],
  ) => {
    if (!housekeeping) {
      housekeeping = { kind: "housekeeping", steps: [] };
      items.push(housekeeping);
    }
    const existing = housekeeping.steps.find((s) => s.phase === phase);
    if (existing) {
      existing.running = running;
      if (summaries !== undefined) existing.summaries = summaries;
    } else {
      housekeeping.steps.push({
        phase,
        running,
        ...(summaries !== undefined ? { summaries } : {}),
      });
    }
  };

  for (const p of parts) {
    if (p.type === "data-tool-progress") {
      // Live streaming text for a tool card — route to the tool item by id.
      // Does not create an item of its own and must not flush text.
      const d = p.data as
        | { toolCallId?: string; text?: string; stage?: string }
        | undefined;
      if (d?.toolCallId && typeof d.text === "string") {
        const target = items.find(
          (it): it is Extract<StreamItem, { kind: "tool" }> =>
            it.kind === "tool" && it.toolCallId === d.toolCallId,
        );
        if (target) {
          target.streamingText = d.text;
          if (d.stage !== undefined) target.streamingStage = d.stage;
        } else {
          pendingProgress.set(d.toolCallId, d.text);
        }
      }
      continue;
    }

    if (p.type === "reasoning") {
      flushText();
      const reasoningText = (p as { text: string }).text ?? "";
      // Merge consecutive reasoning deltas
      const last = items.length > 0 ? items[items.length - 1] : null;
      if (last?.kind === "reasoning") {
        last.text += reasoningText;
      } else {
        items.push({ kind: "reasoning", text: reasoningText });
      }
    } else if (p.type === "text") {
      // Bridge authoritative re-emit (the envelope result diverged from the
      // advisory deltas): the marked block REPLACES every text item streamed
      // so far instead of appending — bridge turns have a single answer
      // block, so dropping the advisory text is exactly "the result wins".
      if (p.providerMetadata?.["previously-bridge"]?.authoritative === true) {
        textBuf = [];
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === "text") items.splice(i, 1);
        }
      }
      textBuf.push(p.text ?? "");
    } else if (p.type === "data-phase") {
      flushText();
      const d = p.data as
        | {
            phase?: string;
            running?: boolean;
            mode?: string;
            summaries?: string[];
            compact?: boolean;
            tools?: BridgeToolRow[];
            live?: string;
            steps?: HousekeepingStep[];
            warning?: string;
          }
        | undefined;
      if (d?.phase) {
        if (Array.isArray(d.tools)) {
          // Bridge activity (client+bridge mode) — the generic tool-event
          // indicator. Frames are cumulative (each carries the full tools
          // list + the current narration line); merge by phase name, last
          // chunk wins. Chat and housekeeping use distinct phase names, so
          // they never merge.
          const existing = items.find(
            (it): it is Extract<StreamItem, { kind: "bridge-tools" }> =>
              it.kind === "bridge-tools" && it.phase === d.phase,
          );
          if (existing) {
            existing.running = d.running ?? false;
            existing.tools = d.tools;
            existing.live = d.live;
            if (d.steps !== undefined) existing.steps = d.steps;
            if (d.warning !== undefined) existing.warning = d.warning;
          } else {
            items.push({
              kind: "bridge-tools",
              phase: d.phase,
              running: d.running ?? false,
              tools: d.tools,
              ...(d.live !== undefined ? { live: d.live } : {}),
              ...(d.steps !== undefined ? { steps: d.steps } : {}),
              ...(d.warning !== undefined ? { warning: d.warning } : {}),
            });
          }
        } else if (d.compact) {
          // Housekeeping sub-step — merge into the single grouped card.
          upsertHousekeepingStep(d.phase, d.running ?? false, d.summaries);
        } else {
          // Regular (non-compact) phase — merge with existing item of the
          // same name, which emits { running: true } at start and
          // { running: false, summaries: [...] } at end.
          const existing = items.find(
            (it): it is Extract<StreamItem, { kind: "phase" }> =>
              it.kind === "phase" && it.phase === d.phase,
          );
          if (existing) {
            existing.running = d.running ?? false;
            if (d.mode !== undefined) existing.mode = d.mode;
            if (d.summaries !== undefined) existing.summaries = d.summaries;
          } else {
            items.push({
              kind: "phase",
              phase: d.phase,
              running: d.running ?? false,
              mode: d.mode,
              summaries: d.summaries,
            });
          }
        }
      }
    } else if (p.type === "data-evolution") {
      // Inline card evolution (Previously Agent) — its OWN stream item at the
      // natural arrival position (between the housekeeping context and strands
      // phases). While running it carries the step + the agent's realtime
      // thinking line (`live`); the terminal chunk carries the summary,
      // mutations diff, note, error, and the partial flag.
      flushText();
      const d = p.data as EvolutionStepData | undefined;
      if (d) {
        // Legacy chunks predate `status` — infer it from the old `running`
        // flag so replays of pre-status streams still classify correctly.
        const running =
          d.status !== undefined ? d.status === "running" : (d.running ?? false);
        const existing = items.find(
          (it): it is Extract<StreamItem, { kind: "evolution" }> =>
            it.kind === "evolution",
        );
        if (existing) {
          existing.running = running;
          existing.data = d;
        } else {
          items.push({ kind: "evolution", running, data: d });
        }
      }
    } else if (p.type === "data-turn-status") {
      // Terminal status only (done / interrupted / error) — the mid-turn
      // thinking/synthesizing lifecycle was removed when thinkDeep became an
      // agent-as-a-tool. Surface interrupted/error inline; done renders nothing
      // (the reply text is the completion signal).
      flushText();
      const turnData = p.data as
        | { status?: string; error?: string }
        | undefined;
      const status = turnData?.status;
      if (!status || status === "active" || status === "done") continue;

      const terminalPhase =
        status === "interrupted" ? "terminal-interrupted" : "terminal-error";
      const existing = items.find(
        (it): it is Extract<StreamItem, { kind: "phase" }> =>
          it.kind === "phase" && it.phase === terminalPhase,
      );
      if (!existing) {
        items.push({
          kind: "phase",
          phase: terminalPhase,
          running: false,
          mode: "terminal",
          // The client-visible explanation for a terminal/model failure — the
          // turn ended for a reason the user should see, not silently.
          summaries: turnData?.error ? [turnData.error] : [],
        });
      }
    } else if (p.type?.startsWith("tool-")) {
      flushText();
      const toolCallId =
        (p as { toolCallId?: string }).toolCallId ?? `anon-${items.length}`;
      const toolName =
        (p as { toolName?: string }).toolName ?? p.type.replace("tool-", "");

      // Merge tool parts sharing the same toolCallId into one StreamItem.
      // The AI SDK emits separate parts for input-streaming → input-available →
      // output-available; we fold them into a single card so it doesn't remount.
      const existing = items.find(
        (it): it is Extract<StreamItem, { kind: "tool" }> =>
          it.kind === "tool" && it.toolCallId === toolCallId,
      );
      if (existing) {
        existing.state = p.state ?? existing.state;
        if (p.input !== undefined) existing.input = p.input;
        if (p.output !== undefined) existing.output = p.output;
      } else {
        items.push({
          kind: "tool",
          toolCallId,
          toolName,
          state: (p as { state?: string }).state ?? "running",
          input: p.input,
          output: p.output,
          streamingText: pendingProgress.get(toolCallId),
        });
        pendingProgress.delete(toolCallId);
      }
    }
  }
  flushText();

  return items;
}

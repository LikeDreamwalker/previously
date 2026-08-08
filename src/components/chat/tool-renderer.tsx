"use client";

import { extractRenderState } from "@/lib/chat/tool-state";
import { ListFilesRenderer } from "./tool-renderers/list-files";
import { MemoryToolRenderer } from "./tool-renderers/memory-tool";
import { RecallToolRenderer } from "./tool-renderers/recall";
import { WebSearchRenderer } from "./tool-renderers/web-search";
import { WebFetchRenderer } from "./tool-renderers/web-fetch";
import { LoopToolRenderer } from "./tool-renderers/loop";
import { ThinkDeepToolRenderer } from "./tool-renderers/think-deep";
import { SuggestMemoryUpdateRenderer } from "./tool-renderers/suggest-memory-update";
import { DefaultRenderer } from "./tool-renderers/default";

interface ToolRendererProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  /** Live streaming text from `data-tool-progress` — fed to PhaseIndicator's typewriter subtitle. */
  streamingText?: string;
  /** Progress stage ("reasoning" | "writing" | "running") — drives subtitle tone. */
  streamingStage?: string;
  isStreaming: boolean;
}

/**
 * Central dispatch for tool rendering.
 *
 * Each renderer receives the raw tool name and computes its own display name
 * from input/output data — no pre-computed labels. This lets renderers produce
 * content-aware names (e.g. "查看了 7月25日 的对话" instead of "查看时间片").
 */
export function ToolRenderer({ toolName, state, input, output, streamingText, streamingStage, isStreaming }: ToolRendererProps) {
  const renderState = extractRenderState({ state }, null, isStreaming);

  switch (toolName) {
    case "readSlice":
    case "readAgentTimeline":
    case "readPreviously":
    case "readTimeline":
    case "readStrand":
      return (
        <MemoryToolRenderer
          toolName={toolName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "listSlices":
    case "listStrands":
      return (
        <ListFilesRenderer
          toolName={toolName}
          input={input as { path?: string } | undefined}
          output={output as Array<{ name: string; type: string }> | undefined}
          state={renderState}
        />
      );
    case "webSearch":
      return (
        <WebSearchRenderer
          toolName={toolName}
          input={input}
          output={output}
          state={renderState}
          streamingText={streamingText}
          streamingStage={streamingStage}
        />
      );
    case "webFetch":
      return (
        <WebFetchRenderer
          toolName={toolName}
          input={input}
          output={output}
          state={renderState}
        />
      );
    case "recall":
      return (
        <RecallToolRenderer
          toolName={toolName}
          input={input}
          output={output}
          state={renderState}
          streamingText={streamingText}
          streamingStage={streamingStage}
        />
      );
    case "startLoop":
      return (
        <LoopToolRenderer
          input={input as { goal?: string; tags?: string[] } | undefined}
          output={
            output as
              | { ok?: boolean; loopId?: string; filePath?: string; error?: string }
              | undefined
          }
          state={renderState}
        />
      );
    case "thinkDeep":
      return (
        <ThinkDeepToolRenderer
          input={
            input as
              | { question?: string; effort?: "low" | "medium" | "high" }
              | undefined
          }
          output={
            output as
              | {
                  ok?: boolean;
                  status?: "completed" | "timeout" | "error";
                  answer?: string;
                  reasoning?: string;
                  error?: string;
                  note?: string;
                }
              | undefined
          }
          state={renderState}
          streamingText={streamingText}
          streamingStage={streamingStage}
        />
      );
    case "suggestMemoryUpdate":
      return (
        <SuggestMemoryUpdateRenderer
          input={input as { summary?: string } | undefined}
          output={
            output as { ok?: boolean; status?: string; summary?: string } | undefined
          }
          state={renderState}
        />
      );
    default:
      return (
        <DefaultRenderer
          toolName={toolName}
          input={input}
          state={renderState}
        />
      );
  }
}

export { ToolLayout } from "./tool-layout";
export type { ToolLayoutProps } from "./tool-layout";

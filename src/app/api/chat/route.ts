/**
 * POST /api/chat — durable chat turn.
 *
 * Every turn now runs inside a Vercel Workflow run (see ./turn-workflow). This
 * handler is intentionally thin: parse + validate the request, hand off to
 * `startTurn` (which builds the serializable input and starts the run), and
 * stream the run's output back. The run id is exposed in the
 * `x-workflow-run-id` header so a disconnected client can reconnect later
 * (Phase 2). All memory I/O happens inside the run's steps, writing to GitHub —
 * the Workflow holds only ephemeral execution state.
 */
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { startTurn } from "./start-turn";
import { createMixedStreamTransform } from "./mixed-stream-transform";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { guardRequest } from "@/lib/security/origin-guard";

export async function POST(request: Request): Promise<Response> {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  try {
    const body = (await request.json()) as {
      messages?: unknown;
      model?: unknown;
      thinking?: unknown;
      effort?: unknown;
      timezone?: unknown;
      locale?: unknown;
    };

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required and must not be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const run = await startTurn({
      messages: messages as UIMessage[],
      model: typeof body.model === "string" ? body.model : undefined,
      thinking: typeof body.thinking === "boolean" ? body.thinking : undefined,
      effort:
        typeof body.effort === "string" &&
        ["low", "medium", "high"].includes(body.effort)
          ? (body.effort as "low" | "medium" | "high")
          : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      locale:
        typeof body.locale === "string" &&
        ["en", "zh"].includes(body.locale)
          ? body.locale
          : undefined,
    });

    return createUIMessageStreamResponse({
      stream: run.readable.pipeThrough(createMixedStreamTransform()),
      headers: { "x-workflow-run-id": run.runId },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (error instanceof Error && error.message.includes("environment variables")) {
      console.error("[chat] Configuration error:", error.message);
      return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    // v0.8: full diagnostic trail for anything the request handler didn't
    // handle (startTurn failures, workflow-start errors, stream-setup throws).
    console.error("[chat] POST /api/chat unhandled:", formatErrorDetail(error));
    throw error;
  }
}

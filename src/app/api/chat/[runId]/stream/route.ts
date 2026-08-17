/**
 * GET /api/chat/[runId]/stream — reconnect to a durable chat turn.
 *
 * When a client drops mid-response (tab closed, phone slept, function timed
 * out), it re-attaches here: the run's output stream is durable (Redis-backed
 * on Vercel, filesystem locally), so we replay its chunks from `startIndex`.
 * `WorkflowChatTransport` calls this automatically — on the same-session retry
 * loop, and on a post-reload resume using the run id it persisted to
 * localStorage.
 *
 * Default `startIndex` is 0 (replay the whole turn), which keeps the AI SDK's
 * part grammar intact — a fresh client has no prior chunks, so a full replay of
 * the single turn renders cleanly. The `x-workflow-stream-tail-index` header is
 * returned so the transport can resolve negative offsets if ever configured.
 */
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { createMixedStreamTransform } from "../../mixed-stream-transform";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
): Promise<Response> {
  const { runId } = await params;
  const { searchParams } = new URL(request.url);
  const startIndexParam = searchParams.get("startIndex");
  const parsed = startIndexParam !== null ? parseInt(startIndexParam, 10) : 0;
  const startIndex = Number.isFinite(parsed) ? parsed : 0;

  try {
    const run = getRun(runId);
    const status = await run.status;

    // failed / cancelled runs have nothing valid to recover — emit a clean
    // terminal so the client ends cleanly instead of retrying a stream that
    // will never deliver a finish chunk. A COMPLETED run, however, must return
    // its actual stream: the client may have dropped before receiving the
    // finish chunk, and the durable stream still carries the full reply. A bare
    // terminal here would leave the client with an empty assistant turn (the
    // mount-resume path strips the partial turn before replaying — see
    // chat-page.tsx — so the rebuild must come from the stream, not a terminal).
    if (status === "failed" || status === "cancelled") {
      const terminalStream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: "finish-step" } as UIMessageChunk);
          controller.enqueue({ type: "finish" } as UIMessageChunk);
          controller.close();
        },
      });
      return createUIMessageStreamResponse({
        stream: terminalStream.pipeThrough(createMixedStreamTransform()),
      });
    }

    const readable = run.getReadable({ startIndex });
    const tailIndex = await readable.getTailIndex();

    return createUIMessageStreamResponse({
      // Same transform as the POST path: the raw run stream mixes our
      // UIMessageChunks (data-flash / data-reasoning / lifecycle) with the
      // agent's ModelCallStreamParts — the client only speaks UIMessageChunk.
      stream: readable.pipeThrough(createMixedStreamTransform()),
      headers: { "x-workflow-stream-tail-index": String(tailIndex) },
    });
  } catch (err) {
    console.warn(
      `[chat/reconnect] run ${runId} unavailable:\n${formatErrorDetail(err)}`
    );
    return new Response(
      JSON.stringify({ error: "Run not available for reconnect" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}

"use client";

import { formatErrorDetail } from "@/lib/chat/workflow-errors";

/**
 * Client-side trace logger for the workflow / chat pipeline. Every line is
 * prefixed `[trace][area]` + a timestamp so the full flow can be followed in
 * the browser console and grepped. Deliberately verbose — a diagnostic aid for
 * tracing where the stream / reconnect actually runs and what it returns.
 */
export function clientTrace(area: string, message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`[trace][${area}] ${stamp} ${message}`);
}

/** Cap for a single chunk's preview so a huge text chunk can't flood the log. */
const CHUNK_PREVIEW = 300;

/** Compact one-line summary of a streamed chunk (handles SSE `data:` lines too). */
function summarizeChunk(line: string): string {
  const trimmed = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return `raw: ${trimmed.slice(0, CHUNK_PREVIEW)}`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `value: ${trimmed.slice(0, CHUNK_PREVIEW)}`;
  }
  const c = parsed as Record<string, unknown>;
  const type = typeof c.type === "string" ? c.type : "?";
  const id = typeof c.id === "string" ? c.id : "";
  const preview = JSON.stringify(c).slice(0, CHUNK_PREVIEW);
  return `${type} id=${id} ${preview}`;
}

/**
 * Read a tee'd copy of a response body line by line and log every chunk —
 * plus the FULL raw error if the stream dies mid-read. The transport swallows
 * stream errors internally (console.error, no rethrow), so this trace branch
 * is the only place the raw failure surfaces.
 */
async function traceStream(
  stream: ReadableStream<Uint8Array>,
  url: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        clientTrace("stream", `EOF ${url} (${count} chunks)`);
        break;
      }
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        count++;
        clientTrace("stream", `${url} #${count} ${summarizeChunk(line)}`);
      }
    }
  } catch (err) {
    clientTrace("stream", `✗ STREAM ERROR ${url} ${formatErrorDetail(err)}`);
  }
}

/**
 * Wrap the transport's fetch so EVERY request, response header, streamed chunk
 * and stream failure is logged. Pass as `fetch` to WorkflowChatTransport.
 */
export function createTracedFetch(inner: typeof fetch): typeof fetch {
  const traced: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as Request).url ?? input);
    const method = (
      init?.method ??
      (typeof input === "string" ? "GET" : (input as Request).method ?? "GET")
    ).toUpperCase();

    clientTrace(
      "fetch",
      `→ ${method} ${url}${init?.body ? ` body=${String(init.body).length}B` : ""}`,
    );
    try {
      const res = await inner(input, init);
      clientTrace("fetch", `← ${method} ${url} status=${res.status}`);
      const runId = res.headers.get("x-workflow-run-id");
      const tail = res.headers.get("x-workflow-stream-tail-index");
      if (runId) clientTrace("fetch", `  runId=${runId}`);
      if (tail) clientTrace("fetch", `  tail=${tail}`);
      if (!res.body) {
        clientTrace("fetch", `  no body (${url})`);
        return res;
      }
      const [a, b] = res.body.tee();
      void traceStream(a, url);
      return new Response(b, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (err) {
      clientTrace("fetch", `✗ ${method} ${url} THREW ${formatErrorDetail(err)}`);
      throw err;
    }
  };
  return traced;
}

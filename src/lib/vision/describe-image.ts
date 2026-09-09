/**
 * One-shot vision-model call — turn an image into a text description.
 *
 * This is an INFRASTRUCTURE call: it always reaches the DeepSeek
 * OpenAI-compatible endpoint with the vision-capable
 * `deepseek-v4-flash-vision-exp` model and always needs a `DEEPSEEK_API_KEY`,
 * independent of the user's chosen chat model. A missing key is surfaced as a
 * user-facing error before any network or model call runs.
 */

import { generateText } from "ai";
import { createModel } from "@/lib/models/provider";
import { getModel } from "@/lib/models/registry";
import { fetchWithGuard, isPrivateHost } from "@/lib/search/fetch-utils";

/** Hard cap on fetched image bytes (10 MB). Large images are rejected so data
 *  URLs do not bloat the step/workflow payload. */
const IMAGE_FETCH_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 60_000;

export type DescribeImageInput = {
  image:
    | { data: string /* base64 or data URL */; mediaType: string }
    | { url: string };
  question?: string;
  timeoutMs?: number;
  locale?: string;
};

export type DescribeImageResult =
  | { ok: true; description: string }
  | { ok: false; error: string };

function isDataUrl(s: string): boolean {
  return s.startsWith("data:");
}

function normalizeImageInput(
  image: DescribeImageInput["image"],
): { data: string; mimeType?: string } {
  if ("url" in image) {
    return { data: image.url };
  }
  const data = image.data.trim();
  if (isDataUrl(data)) {
    return { data };
  }
  return { data, mimeType: image.mediaType };
}

async function readImageBytes(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "");
  let truncated = Number.isFinite(declared) && declared > maxBytes;

  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) truncated = true;
    return { bytes: bytes.subarray(0, maxBytes), truncated };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const merged = new Uint8Array(
    chunks.reduce((n, c) => n + c.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, truncated };
}

async function fetchImageAsDataUrl(url: string): Promise<
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }
> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "ERROR: Invalid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error:
        "ERROR: Unsupported URL protocol. Only http:// and https:// are allowed.",
    };
  }
  if (isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      error: "ERROR: Cannot fetch local or private network addresses.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchWithGuard(parsed.toString(), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `ERROR: HTTP ${res.status} ${res.statusText}`,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return {
        ok: false,
        error: `ERROR: URL returned non-image content type (${contentType || "none"}). viewImage only accepts image URLs.`,
      };
    }

    const { bytes, truncated } = await readImageBytes(
      res,
      IMAGE_FETCH_MAX_BYTES,
    );
    if (truncated) {
      return {
        ok: false,
        error: `ERROR: Image is larger than ${Math.round(IMAGE_FETCH_MAX_BYTES / 1024 / 1024)} MB.`,
      };
    }

    const base64 = Buffer.from(bytes).toString("base64");
    const dataUrl = `data:${contentType};base64,${base64}`;
    return { ok: true, dataUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `ERROR: Could not fetch image: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function buildInstruction(
  question: string | undefined,
  locale?: string,
): string {
  const langHint =
    locale === "zh"
      ? "用中文回答。"
      : locale === "en"
        ? "Answer in English."
        : "Answer in the language of the question, or in the language that best fits the image context.";

  if (question?.trim()) {
    return (
      `Look at the image and answer the question concisely but thoroughly. ` +
      `Focus on what is visible and be honest about uncertainty. ${langHint}\n\n` +
      `Question: ${question.trim()}`
    );
  }

  return (
    `Describe the image in a structured way: what it is, the key content, ` +
    `notable details, and any uncertainties. ${langHint}`
  );
}

/**
 * One-shot image-to-text. Never throws — returns an error union on failure.
 */
export async function describeImage(
  input: DescribeImageInput,
): Promise<DescribeImageResult> {
  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      ok: false,
      error:
        "Image viewing requires a DEEPSEEK_API_KEY. It runs as a separate DeepSeek " +
        "infrastructure call independent of the chat model you selected. Add " +
        "DEEPSEEK_API_KEY to enable it.",
    };
  }

  let imageData: { data: string; mimeType?: string };
  if ("url" in input.image) {
    const fetched = await fetchImageAsDataUrl(input.image.url);
    if (!fetched.ok) return fetched;
    imageData = { data: fetched.dataUrl };
  } else {
    imageData = normalizeImageInput(input.image);
  }

  const visionModel = getModel("deepseek-v4-flash-vision-exp");
  if (!visionModel) {
    return {
      ok: false,
      error:
        "ERROR: Vision model deepseek-v4-flash-vision-exp is not available.",
    };
  }

  try {
    const { text } = await generateText({
      model: createModel(visionModel),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: imageData.data,
              ...(imageData.mimeType ? { mimeType: imageData.mimeType } : {}),
            },
            { type: "text", text: buildInstruction(input.question, input.locale) },
          ],
        },
      ],
      timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { ok: true, description: text.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `ERROR: Could not describe image: ${msg}` };
  }
}

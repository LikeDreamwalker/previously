import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DescribeImageResult } from "@/lib/vision/describe-image";

const aiSdk = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", () => ({
  generateText: aiSdk.generateText,
}));

const registry = vi.hoisted(() => ({ getModel: vi.fn() }));
vi.mock("@/lib/models/registry", () => ({
  getModel: registry.getModel,
  ALL_MODELS: [],
}));

const provider = vi.hoisted(() => ({ createModel: vi.fn() }));
vi.mock("@/lib/models/provider", () => ({
  createModel: provider.createModel,
}));

const fetchUtils = vi.hoisted(() => ({
  fetchWithGuard: vi.fn(),
  isPrivateHost: vi.fn(() => false),
}));
vi.mock("@/lib/search/fetch-utils", () => ({
  fetchWithGuard: fetchUtils.fetchWithGuard,
  isPrivateHost: fetchUtils.isPrivateHost,
}));

import { describeImage } from "@/lib/vision/describe-image";

const SAVED_ENV = { ...process.env };

function assertError(r: DescribeImageResult): asserts r is { ok: false; error: string } {
  expect(r.ok).toBe(false);
}

function assertOk(r: DescribeImageResult): asserts r is { ok: true; description: string } {
  expect(r.ok).toBe(true);
}

function makeImageResponse(
  contentType = "image/png",
  body: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
): Response {
  return new Response(body as unknown as BodyInit, {
    headers: { "content-type": contentType },
    status: 200,
    statusText: "OK",
  });
}

describe("describeImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED_ENV, DEEPSEEK_API_KEY: "test-key" };
    registry.getModel.mockReturnValue({
      id: "deepseek-v4-flash-vision-exp",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
      capabilities: { vision: true, thinking: true, maxTokens: 393216 },
      defaultThinking: true,
      defaultEffort: "low",
    });
    provider.createModel.mockReturnValue({ __kind: "languageModel" });
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("returns an honest error when DEEPSEEK_API_KEY is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const result = await describeImage({
      image: { data: "data:image/png;base64,xx", mediaType: "image/png" },
    });
    assertError(result);
    expect(result.error).toContain("DEEPSEEK_API_KEY");
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("rejects non-image content types from URLs", async () => {
    fetchUtils.fetchWithGuard.mockResolvedValue(
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      }),
    );

    const result = await describeImage({ image: { url: "https://example.com/x" } });
    assertError(result);
    expect(result.error).toContain("non-image content type");
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("returns an error when fetching the image fails", async () => {
    fetchUtils.fetchWithGuard.mockRejectedValue(new Error("network down"));

    const result = await describeImage({ image: { url: "https://example.com/x.png" } });
    assertError(result);
    expect(result.error).toContain("Could not fetch image");
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("describes an image from a URL with a question", async () => {
    fetchUtils.fetchWithGuard.mockResolvedValue(makeImageResponse());
    aiSdk.generateText.mockResolvedValue({ text: "A red circle." });

    const result = await describeImage({
      image: { url: "https://example.com/circle.png" },
      question: "What color is it?",
      locale: "en",
    });

    assertOk(result);
    expect(result.description).toBe("A red circle.");
    expect(aiSdk.generateText).toHaveBeenCalledTimes(1);
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.model).toEqual({ __kind: "languageModel" });
    expect(args.messages[0].content).toHaveLength(2);
    expect(args.messages[0].content[1].text).toContain("What color is it?");
  });

  it("describes an image from base64 data", async () => {
    aiSdk.generateText.mockResolvedValue({ text: "A cat." });

    const result = await describeImage({
      image: { data: "iVBORw0KGgo=", mediaType: "image/png" },
      locale: "zh",
    });

    assertOk(result);
    expect(result.description).toBe("A cat.");
    expect(aiSdk.generateText).toHaveBeenCalledTimes(1);
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.messages[0].content[0].image).toBe("iVBORw0KGgo=");
    expect(args.messages[0].content[0].mimeType).toBe("image/png");
    expect(args.messages[0].content[1].text).toContain("用中文回答");
  });

  it("accepts a data URL as image data", async () => {
    aiSdk.generateText.mockResolvedValue({ text: "A dog." });

    const result = await describeImage({
      image: { data: "data:image/jpeg;base64,xx", mediaType: "image/jpeg" },
    });

    assertOk(result);
    expect(result.description).toBe("A dog.");
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.messages[0].content[0].image).toBe("data:image/jpeg;base64,xx");
    expect(args.messages[0].content[0]).not.toHaveProperty("mimeType");
  });

  it("errors when the vision model is missing from the registry", async () => {
    registry.getModel.mockReturnValue(undefined);

    const result = await describeImage({
      image: { data: "data:image/png;base64,xx", mediaType: "image/png" },
    });

    assertError(result);
    expect(result.error).toContain("deepseek-v4-flash-vision-exp");
  });

  it("surfaces model errors as the error union", async () => {
    aiSdk.generateText.mockRejectedValue(new Error("rate limited"));

    const result = await describeImage({
      image: { data: "data:image/png;base64,xx", mediaType: "image/png" },
    });

    assertError(result);
    expect(result.error).toContain("rate limited");
  });
});

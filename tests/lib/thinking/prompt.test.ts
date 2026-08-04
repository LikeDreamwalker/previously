import { describe, it, expect } from "vitest";
import { buildThinkPrompt, buildIntegrationPrompt } from "@/lib/thinking/prompt";
import type { ThinkInput } from "@/lib/thinking/types";

const BASE_INPUT: ThinkInput = {
  thinkId: "think-test",
  question: "Is Rust a good fit for a CLI tool?",
  effort: "high",
  sharedContext: "## Identity\nYou are Pro.\n\n## Memory\nSome memory.",
  model: {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    providerName: "DeepSeek",
    sdk: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
    defaultThinking: true,
    defaultEffort: "low",
  },
  owner: "o",
  repo: "r",
  useGithub: true,
  startedAt: "2026-08-04T10:00:00.000Z",
};

describe("buildThinkPrompt", () => {
  it("places sharedContext before the question (prefix for cache hits)", () => {
    const prompt = buildThinkPrompt(BASE_INPUT);
    const sharedIdx = prompt.indexOf("## Identity");
    const questionIdx = prompt.indexOf("Is Rust a good fit");
    expect(sharedIdx).toBeGreaterThan(-1);
    expect(questionIdx).toBeGreaterThan(sharedIdx);
  });

  it("includes the question verbatim", () => {
    expect(buildThinkPrompt(BASE_INPUT)).toContain(
      "Question: Is Rust a good fit for a CLI tool?",
    );
  });

  it("includes the outputFormat line when provided", () => {
    const prompt = buildThinkPrompt({
      ...BASE_INPUT,
      outputFormat: "pros and cons table",
    });
    expect(prompt).toContain("Report format: pros and cons table");
  });

  it("omits the format line when absent", () => {
    expect(buildThinkPrompt(BASE_INPUT)).not.toContain("Report format");
  });
});

describe("buildIntegrationPrompt", () => {
  it("wraps reports and instructs synthesis", () => {
    const prompt = buildIntegrationPrompt("### Thinking agent — think-a (completed)\n\nFindings.");
    expect(prompt).toContain("Findings.");
    expect(prompt).toContain("Do NOT repeat the reports verbatim");
  });

  it("instructs handling of interrupted reports", () => {
    const prompt = buildIntegrationPrompt("### Thinking agent — think-b (interrupted)\n\nPartial.");
    expect(prompt).toContain("interrupted");
  });
});

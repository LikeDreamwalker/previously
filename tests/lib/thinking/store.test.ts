import { describe, it, expect, afterEach, vi } from "vitest";
import { unlinkSync, existsSync } from "fs";
import {
  writeTaskCard,
  writeReport,
  readReport,
  reportExists,
  taskPath,
  reportPath,
} from "@/lib/thinking/store";
import type { ThinkInput, ThinkReport } from "@/lib/thinking/types";

const THINK_ID = `think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TASK = taskPath(THINK_ID);
const REPORT = reportPath(THINK_ID);

const INPUT: ThinkInput = {
  thinkId: THINK_ID,
  question: "Test question?",
  effort: "low",
  sharedContext: "prefix",
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
  useGithub: false,
  startedAt: "2026-08-04T10:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of [TASK, REPORT]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore — already gone
    }
  }
});

describe("thinking store (local source)", () => {
  it("writes a task card", async () => {
    vi.stubEnv("STORAGE", "local");
    await writeTaskCard(INPUT);
    expect(existsSync(TASK)).toBe(true);
  });

  it("writes and reads back a report round-trip with status", async () => {
    vi.stubEnv("STORAGE", "local");
    const report: ThinkReport = {
      thinkId: THINK_ID,
      question: INPUT.question,
      status: "completed",
      startedAt: INPUT.startedAt,
      updatedAt: "2026-08-04T10:05:00.000Z",
      content: "# Findings\n\nDeep report body.",
    };
    await writeReport(report);

    const read = await readReport(THINK_ID);
    expect(read?.status).toBe("completed");
    expect(read?.content).toContain("Deep report body.");
    expect(read?.thinkId).toBe(THINK_ID);
  });

  it("reportExists is false before writing, true after", async () => {
    vi.stubEnv("STORAGE", "local");
    expect(await reportExists(THINK_ID)).toBe(false);
    await writeReport({
      thinkId: THINK_ID,
      question: "",
      status: "interrupted",
      startedAt: "",
      updatedAt: "",
      content: "",
    });
    expect(await reportExists(THINK_ID)).toBe(true);
  });

  it("readReport returns null for an unknown thinkId", async () => {
    vi.stubEnv("STORAGE", "local");
    expect(await readReport(`missing-${THINK_ID}`)).toBeNull();
  });
});

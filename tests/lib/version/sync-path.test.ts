import { describe, it, expect } from "vitest";
import { shouldSyncPath } from "@/lib/version/constants";

describe("shouldSyncPath", () => {
  // ── Code directories (should sync) ──

  it("returns true for src/ files", () => {
    expect(shouldSyncPath("src/app/layout.tsx")).toBe(true);
    expect(shouldSyncPath("src/lib/version/constants.ts")).toBe(true);
    expect(shouldSyncPath("src/components/chat/chat-message.tsx")).toBe(true);
  });

  it("returns true for public/ files", () => {
    expect(shouldSyncPath("public/favicon.ico")).toBe(true);
    expect(shouldSyncPath("public/llms.txt")).toBe(true);
  });

  it("returns true for messages/ files", () => {
    expect(shouldSyncPath("messages/en.json")).toBe(true);
    expect(shouldSyncPath("messages/zh.json")).toBe(true);
  });

  it("returns true for scripts/ files", () => {
    expect(shouldSyncPath("scripts/seed-demo.ts")).toBe(true);
  });

  it("returns true for config/ files", () => {
    expect(shouldSyncPath("config/speed-index.json")).toBe(true);
  });

  it("returns true for tests/ files", () => {
    expect(shouldSyncPath("tests/lib/whitelist/whitelist.test.ts")).toBe(true);
  });

  it("returns true for identity/ files", () => {
    expect(shouldSyncPath("identity/agent/profile.md")).toBe(true);
  });

  it("returns true for .github/ files", () => {
    expect(shouldSyncPath(".github/workflows/bump-version.yml")).toBe(true);
  });

  // ── Root config files (should sync) ──

  it("returns true for package.json", () => {
    expect(shouldSyncPath("package.json")).toBe(true);
  });

  it("returns true for pnpm-lock.yaml", () => {
    expect(shouldSyncPath("pnpm-lock.yaml")).toBe(true);
  });

  it("returns true for next.config.ts", () => {
    expect(shouldSyncPath("next.config.ts")).toBe(true);
  });

  it("returns true for tsconfig.json", () => {
    expect(shouldSyncPath("tsconfig.json")).toBe(true);
  });

  it("returns true for vercel.json", () => {
    expect(shouldSyncPath("vercel.json")).toBe(true);
  });

  it("returns true for .gitignore", () => {
    expect(shouldSyncPath(".gitignore")).toBe(true);
  });

  it("returns true for README.md", () => {
    expect(shouldSyncPath("README.md")).toBe(true);
  });

  it("returns true for LICENSE", () => {
    expect(shouldSyncPath("LICENSE")).toBe(true);
  });

  // ── Data directories (should NOT sync) ──

  it("returns false for memory/ files", () => {
    expect(shouldSyncPath("memory/nodes/welcome.md")).toBe(false);
    expect(shouldSyncPath("memory/user/profile.md")).toBe(false);
  });

  it("returns false for tasks/ files", () => {
    expect(shouldSyncPath("tasks/todo.md")).toBe(false);
  });

  it("returns false for sessions/ files", () => {
    expect(shouldSyncPath("sessions/active.json")).toBe(false);
  });

  it("returns false for content/ files (docs moved to the external site)", () => {
    expect(shouldSyncPath("content/docs/en/deployment.md")).toBe(false);
    expect(shouldSyncPath("content/docs/zh/deployment.md")).toBe(false);
  });

  // ── Excluded subdirectories (gitignored — belt and suspenders) ──

  it("returns false for memory/episodic/ (gitignored, also excluded)", () => {
    expect(shouldSyncPath("memory/episodic/2026/07/19/1430.md")).toBe(false);
  });

  // ── Edge cases ──

  it("handles paths with leading slash", () => {
    expect(shouldSyncPath("/src/app/page.tsx")).toBe(true);
  });

  it("handles paths with Windows backslashes", () => {
    expect(shouldSyncPath("src\\lib\\utils.ts")).toBe(true);
  });

  it("returns false for unknown root files", () => {
    expect(shouldSyncPath("random-file.txt")).toBe(false);
  });

  it("returns false for paths outside sync dirs", () => {
    expect(shouldSyncPath("node_modules/some-pkg/index.js")).toBe(false);
    expect(shouldSyncPath("dist/output.js")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldSyncPath("")).toBe(false);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  writeTurnState,
  readTurnState,
  writeRunTurnMapping,
  readTurnIdByRun,
} from "@/lib/sessions/store";
import { unlinkSync, existsSync } from "fs";

// Store writes land on the local filesystem under memory/sessions/ (local
// data source). Use unique ids per test and clean the files up afterwards so
// the repo stays untouched.
const TEST_TURN = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_RUN = `testrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const TURN_PATH = `memory/sessions/${TEST_TURN}.json`;
const RUN_PATH = `memory/sessions/.runs/${TEST_RUN}.json`;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of [TURN_PATH, RUN_PATH]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore — already gone
    }
  }
});

describe("turn state store (local source)", () => {
  it("writes and reads back a TurnState round-trip", async () => {
    vi.stubEnv("STORAGE", "local");
    const state = {
      turnId: TEST_TURN,
      status: "done" as const,
      updatedAt: "2026-08-04T10:00:00.000Z",
      partialText: "final answer",
      thinkingAgentIds: ["think-abc"],
    };

    await writeTurnState(state);
    const read = await readTurnState(TEST_TURN);

    expect(read).toEqual(state);
  });

  it("returns null for an unknown turnId", async () => {
    vi.stubEnv("STORAGE", "local");
    expect(await readTurnState(`missing-${TEST_TURN}`)).toBeNull();
  });

  it("registers and resolves the runId → turnId mapping", async () => {
    vi.stubEnv("STORAGE", "local");
    await writeRunTurnMapping(TEST_RUN, TEST_TURN);
    expect(await readTurnIdByRun(TEST_RUN)).toBe(TEST_TURN);
  });

  it("returns null for an unregistered runId", async () => {
    vi.stubEnv("STORAGE", "local");
    expect(await readTurnIdByRun(`missing-${TEST_RUN}`)).toBeNull();
  });
});

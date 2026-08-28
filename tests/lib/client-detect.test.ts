/**
 * client-detect — PATH probing for the bridge agent CLIs. All tests inject a
 * fake probe runner (DetectOptions.run) so nothing touches the real PATH;
 * one sanity test exercises the real spawnProbe against node itself.
 */
import { describe, it, expect } from "vitest";

import {
  detectAgent,
  detectLocalAgents,
  spawnProbe,
  LOCATE_TIMEOUT_MS,
  VERSION_TIMEOUT_MS,
  type ProbeRunner,
  type ProbeResult,
} from "@/lib/client-detect";

/** Build a fake probe runner from a per-argv-0 behavior table. */
function fakeRun(
  behaviors: Record<string, (args: string[]) => ProbeResult>,
): ProbeRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: ProbeRunner & { calls: string[][] } = Object.assign(
    async (argv: string[]) => {
      calls.push(argv);
      const behavior = behaviors[argv[0]];
      if (!behavior) return { code: 1, stdout: "", stderr: "" };
      return behavior(argv.slice(1));
    },
    { calls },
  );
  return run;
}

const located =
  (path: string) =>
  (): ProbeResult => ({ code: 0, stdout: `${path}\n`, stderr: "" });

const versioned =
  (version: string) =>
  (): ProbeResult => ({ code: 0, stdout: `${version}\n`, stderr: "" });

const missing = (): ProbeResult => ({ code: 1, stdout: "", stderr: "" });

describe("detectAgent", () => {
  it("reports path and version when the CLI is installed", async () => {
    const run = fakeRun({
      which: located("/usr/local/bin/claude"),
      claude: versioned("claude 2.1.0"),
    });
    const result = await detectAgent("claude", { run, platform: "linux" });
    expect(result).toEqual({
      name: "claude",
      found: true,
      path: "/usr/local/bin/claude",
      version: "claude 2.1.0",
    });
    // Located via which, then versioned via the CLI itself.
    expect(run.calls).toEqual([
      ["which", "claude"],
      ["claude", "--version"],
    ]);
  });

  it("uses `where` on Windows and parses CRLF output", async () => {
    const run = fakeRun({
      where: () => ({
        code: 0,
        stdout: "C:\\Users\\x\\bin\\codex.cmd\r\n",
        stderr: "",
      }),
      codex: () => ({ code: 0, stdout: "codex 0.5.0\r\n", stderr: "" }),
    });
    const result = await detectAgent("codex", { run, platform: "win32" });
    expect(run.calls[0]).toEqual(["where", "codex"]);
    expect(result).toEqual({
      name: "codex",
      found: true,
      path: "C:\\Users\\x\\bin\\codex.cmd",
      version: "codex 0.5.0",
    });
  });

  it("reports found:false without probing the version when lookup fails", async () => {
    const run = fakeRun({ which: missing });
    const result = await detectAgent("kimi", { run, platform: "darwin" });
    expect(result).toEqual({ name: "kimi", found: false });
    expect(run.calls).toEqual([["which", "kimi"]]);
  });

  it("treats a locate timeout as not found", async () => {
    const run = fakeRun({
      which: () => ({ code: null, stdout: "", stderr: "", error: "timeout" }),
    });
    const result = await detectAgent("claude", { run, platform: "linux" });
    expect(result.found).toBe(false);
  });

  it("still reports found when the version probe fails or times out", async () => {
    for (const versionProbe of [
      (): ProbeResult => ({ code: null, stdout: "", stderr: "", error: "timeout" }),
      (): ProbeResult => ({ code: 2, stdout: "", stderr: "boom" }),
      (): ProbeResult => ({ code: 0, stdout: "   \n", stderr: "" }),
    ]) {
      const run = fakeRun({
        which: () => ({ code: 0, stdout: "/usr/local/bin/claude\n", stderr: "" }),
        claude: versionProbe,
      });
      const result = await detectAgent("claude", { run, platform: "linux" });
      expect(result).toEqual({
        name: "claude",
        found: true,
        path: "/usr/local/bin/claude",
      });
    }
  });
});

describe("detectLocalAgents", () => {
  it("probes exactly the three bridge agents", async () => {
    const run = fakeRun({
      which: (args) =>
        args[0] === "kimi"
          ? { code: 0, stdout: "/home/x/.local/bin/kimi\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
      kimi: () => ({ code: 0, stdout: "kimi 1.2.3\n", stderr: "" }),
    });
    const agents = await detectLocalAgents({ run, platform: "linux" });
    expect(agents.map((a) => a.name)).toEqual(["claude", "codex", "kimi"]);
    expect(agents.find((a) => a.name === "kimi")).toEqual({
      name: "kimi",
      found: true,
      path: "/home/x/.local/bin/kimi",
      version: "kimi 1.2.3",
    });
    expect(agents.find((a) => a.name === "claude")?.found).toBe(false);
    expect(agents.find((a) => a.name === "codex")?.found).toBe(false);
  });
});

describe("spawnProbe (real spawn)", () => {
  it("captures stdout of a real process (node --version)", async () => {
    const result = await spawnProbe([process.execPath, "--version"], 5_000);
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^v\d+\./);
  });

  it("reports a missing binary as an ENOENT error instead of rejecting", async () => {
    const result = await spawnProbe(
      ["previously-detect-definitely-not-installed-xyz"],
      1_000,
    );
    expect(result.error).toBe("ENOENT");
    expect(result.code).toBeNull();
  });

  it("kills a hanging process at the timeout", async () => {
    const result = await spawnProbe(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      300,
    );
    expect(result.error).toBe("timeout");
    expect(result.code).toBeNull();
  });

  it("exposes the timeout budgets the route relies on", () => {
    expect(LOCATE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(VERSION_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

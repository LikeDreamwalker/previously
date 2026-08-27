/**
 * syncDiscoveredSkills startup logging — it runs as a module-load side
 * effect, so each case isolates it with vi.resetModules + a dynamic import,
 * and chdirs into a temp dir so the repo's own .claude/skills cannot leak
 * into the discovery result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "previously-skill-registry-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("syncDiscoveredSkills startup logging", () => {
  it("logs the discovered skill names when skills are found", async () => {
    const skillsDir = join(tmpDir, "deployment-skills");
    mkdirSync(join(skillsDir, "grep-app"), { recursive: true });
    writeFileSync(
      join(skillsDir, "grep-app", "SKILL.md"),
      "---\nname: Grep App\ndescription: Search the app\n---\n",
    );
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", skillsDir);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mod = await import("@/lib/skills/registry");
      expect(spy).toHaveBeenCalledWith(
        "[Skills] Discovered 1 skill(s): Grep App",
      );
      expect(mod.getSkill("/grep-app")).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the PREVIOUSLY_SKILLS_DIR hint when nothing is discovered", async () => {
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", "");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("@/lib/skills/registry");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("PREVIOUSLY_SKILLS_DIR"),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

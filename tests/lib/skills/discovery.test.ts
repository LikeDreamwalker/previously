/**
 * Skill discovery — PREVIOUSLY_SKILLS_DIR support: client-mode kernels run
 * with the install dir as cwd, so the conventional .claude/skills and
 * .agents/skills dirs never exist there; the env dir is the deployment's way
 * to point discovery at real skills.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  getProjectSkillDirectories,
} from "@/lib/skills/discovery";

afterEach(() => vi.unstubAllEnvs());

describe("getProjectSkillDirectories — PREVIOUSLY_SKILLS_DIR", () => {
  it("returns only the two cwd dirs when the env var is unset/empty", () => {
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", "");
    expect(getProjectSkillDirectories()).toEqual([
      join(process.cwd(), ".claude", "skills"),
      join(process.cwd(), ".agents", "skills"),
    ]);
  });

  it("ignores a whitespace-only env dir", () => {
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", "   ");
    expect(getProjectSkillDirectories()).toHaveLength(2);
  });

  it("appends the trimmed env dir after the cwd dirs when set", () => {
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", "  /tmp/deployment-skills  ");
    expect(getProjectSkillDirectories()).toEqual([
      join(process.cwd(), ".claude", "skills"),
      join(process.cwd(), ".agents", "skills"),
      "/tmp/deployment-skills",
    ]);
  });
});

describe("discoverSkills — env dir contents", () => {
  it("discovers skills from the PREVIOUSLY_SKILLS_DIR directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "previously-skills-"));
    try {
      mkdirSync(join(dir, "grep-app"));
      writeFileSync(
        join(dir, "grep-app", "SKILL.md"),
        "---\nname: Grep App\ndescription: Search the app\n---\nBody\n",
      );
      vi.stubEnv("PREVIOUSLY_SKILLS_DIR", dir);

      // Full path: env var → directory list → discovery. The repo's own
      // .claude/skills may contribute more — filter to the env dir's results.
      const fromEnvDir = discoverSkills(getProjectSkillDirectories()).filter(
        (s) => s.path.startsWith(dir),
      );
      expect(fromEnvDir.map((s) => s.name)).toEqual(["Grep App"]);
      expect(fromEnvDir[0]?.description).toBe("Search the app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("silently skips a nonexistent env dir", () => {
    const missing = join(tmpdir(), "previously-skills-does-not-exist");
    vi.stubEnv("PREVIOUSLY_SKILLS_DIR", missing);
    expect(getProjectSkillDirectories()).toContain(missing);
    expect(discoverSkills([missing])).toEqual([]);
  });
});

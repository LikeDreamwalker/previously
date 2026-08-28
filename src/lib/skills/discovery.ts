/**
 * Skill Discovery — scans directories for SKILL.md files.
 * Adapted from Open Agents packages/agent/skills/discovery.ts
 * Uses Node.js fs instead of sandbox interface.
 */
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, basename } from "path";
import type { SkillMetadata, SkillFrontmatter } from "./types";
import { frontmatterToOptions } from "./types";

const SKILL_FILES = ["SKILL.md", "skill.md"];

/** Built-in commands that skills cannot shadow */
const BUILTIN_COMMANDS = new Set(["model", "resume", "new", "clear", "help"]);

/**
 * Parse simple YAML frontmatter from a string.
 * Handles quoted strings and booleans. No heavy YAML parser needed.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex === -1) return null;

  const fm: Record<string, unknown> = {};
  const fmLines = lines.slice(1, endIndex + 1);

  for (const line of fmLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: string = line.slice(colonIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Parse booleans
    if (value === "true") {
      fm[key] = true;
    } else if (value === "false") {
      fm[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      fm[key] = Number(value);
    } else {
      fm[key] = value;
    }
  }

  return fm;
}

/**
 * Discover skills from a list of directory paths.
 * Each skill is a subdirectory containing SKILL.md or skill.md.
 */
export function discoverSkills(
  directories: string[],
): SkillMetadata[] {
  const skills: SkillMetadata[] = [];
  const seen = new Set<string>();

  for (const dir of directories) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      // Find SKILL.md or skill.md
      let skillFile: string | null = null;
      for (const filename of SKILL_FILES) {
        const fullPath = join(skillDir, filename);
        if (existsSync(fullPath)) {
          skillFile = fullPath;
          break;
        }
      }
      if (!skillFile) continue;

      // Parse frontmatter
      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(raw);
      if (!fm || !fm.name || !fm.description) continue;

      const name = String(fm.name);
      const skillName = name.toLowerCase();

      // Skip shadowed built-in commands
      if (BUILTIN_COMMANDS.has(skillName)) continue;

      // Deduplicate (first wins)
      if (seen.has(skillName)) continue;
      seen.add(skillName);

      const frontmatter: SkillFrontmatter = {
        name: String(fm.name),
        description: String(fm.description),
        version: fm.version ? String(fm.version) : undefined,
        "disable-model-invocation": fm["disable-model-invocation"] as boolean | undefined,
        "user-invocable": fm["user-invocable"] as boolean | undefined,
      };

      skills.push({
        name: String(fm.name),
        description: String(fm.description),
        path: skillDir,
        filename: basename(skillFile!),
        options: frontmatterToOptions(frontmatter),
      });
    }
  }

  return skills;
}

/**
 * Get the skill directories for the project.
 *
 * cwd holds the two conventional project dirs; PREVIOUSLY_SKILLS_DIR adds a
 * single deployment-provided directory — client-mode kernels run with the
 * install dir as cwd, so the project dirs never exist there and skills would
 * silently disappear without it.
 */
export function getProjectSkillDirectories(): string[] {
  const dirs = [
    join(process.cwd(), ".claude", "skills"),
    join(process.cwd(), ".agents", "skills"),
  ];
  const envDir = process.env.PREVIOUSLY_SKILLS_DIR?.trim();
  if (envDir) dirs.push(envDir);
  return dirs;
}

import type { SkillConfig } from "./types";
import { discoverSkills, getProjectSkillDirectories } from "./discovery";

const registry = new Map<string, SkillConfig>();

/**
 * Register a skill programmatically.
 */
export function registerSkill(skill: SkillConfig): void {
  registry.set(skill.command, skill);
}

/**
 * Get a skill by its /command.
 */
export function getSkill(command: string): SkillConfig | undefined {
  return registry.get(command);
}

/**
 * Get all registered skills.
 */
export function getAllSkills(): SkillConfig[] {
  return Array.from(registry.values());
}

/**
 * Match skills by a prefix (for slash command autocomplete).
 */
export function matchSkills(prefix: string): SkillConfig[] {
  const lower = prefix.toLowerCase();
  return getAllSkills().filter(
    (s) =>
      s.command.toLowerCase().startsWith(lower) ||
      s.name.toLowerCase().includes(lower),
  );
}

/**
 * Sync discovered file-driven skills into the registry.
 * Called at startup to pick up .claude/skills/, .agents/skills/, and
 * PREVIOUSLY_SKILLS_DIR (see discovery.ts).
 */
export function syncDiscoveredSkills(): void {
  const dirs = getProjectSkillDirectories();
  const discovered = discoverSkills(dirs);

  for (const skill of discovered) {
    const command = `/${skill.name.toLowerCase().replace(/\s+/g, "-")}`;
    // Don't overwrite programmatically registered skills
    if (registry.has(command)) continue;

    registerSkill({
      id: skill.name.toLowerCase().replace(/\s+/g, "-"),
      name: skill.name,
      command,
      description: skill.description,
      skillPath: `${skill.path}/${skill.filename}`,
    });
  }

  // Startup observability: a client-mode kernel's cwd is the install dir, so
  // discovery used to find 0 skills and fail silently — say what happened.
  if (discovered.length > 0) {
    console.log(
      `[Skills] Discovered ${discovered.length} skill(s): ${discovered.map((s) => s.name).join(", ")}`,
    );
  } else {
    console.log(
      "[Skills] No skills discovered — place skill folders (each with a SKILL.md) under .claude/skills or .agents/skills, or point PREVIOUSLY_SKILLS_DIR at a skills directory.",
    );
  }
}

// Sync file-driven skills on module load
syncDiscoveredSkills();

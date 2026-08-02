/**
 * Agent constitution — SOUL + DIRECTIVES, bundled into the build via
 * scripts/generate-identity.mjs (imported as compiled strings, never read from
 * disk at runtime). This makes the agent's identity immutable while running: a
 * bad edit or a mistaken agent write to the repo can't change a live
 * deployment, and the source files sit outside the tool whitelist so the agent
 * can't rewrite its own soul.
 *
 * The user's profile is deliberately NOT here — it's mutable, agent-editable
 * data loaded live from memory/. See ./user-profile.ts.
 */
import matter from "gray-matter";
import { SOUL_MD, DIRECTIVES_MD } from "./agent-prompt.generated";
import type { UserProfile } from "./user-profile";

const soul = matter(SOUL_MD);
const soulName = typeof soul.data.name === "string" ? soul.data.name : "Previously";
const soulBody = soul.content.trim();
const directives = matter(DIRECTIVES_MD).content.trim();

/**
 * Compose the agent's base system prompt: bundled constitution (SOUL + who
 * you're assisting + DIRECTIVES). The caller passes the already-loaded user
 * profile and appends dynamic context (intent, memory, episodic timeline).
 */
export function buildAgentIdentityPrompt(profile: UserProfile | null): string {
  const parts: string[] = [
    soulBody ||
      `You are ${soulName}, a personal AI agent that remembers everything the user does.`,
  ];

  if (profile) {
    const lines: string[] = [];
    if (profile.name) lines.push(`Name: ${profile.name}`);
    if (profile.addressAs) lines.push(`Address them as: ${profile.addressAs}`);
    if (profile.pronouns) lines.push(`Pronouns: ${profile.pronouns}`);
    if (profile.timezone) lines.push(`Timezone: ${profile.timezone}`);
    if (lines.length > 0 || profile.body) {
      let block = "## Who you're assisting\n" + lines.join("\n");
      if (profile.body) block += `\n\n${profile.body}`;
      parts.push(block.trim());
    }
  }

  if (directives) parts.push(directives);

  return parts.join("\n\n");
}

export {
  loadUserProfile,
  getUserName,
  parseIdentityFromPreviously,
} from "./user-profile";
export type { UserProfile } from "./user-profile";

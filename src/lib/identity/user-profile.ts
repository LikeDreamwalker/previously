/**
 * User profile — extracted from previously.md.
 *
 * As of v0.5, the canonical source is the most recent previously.md's
 * "User identity" section. Flash micro-evolution and Pro macro-evolution
 * manage beliefs automatically; there is no separate profile file.
 */

export interface UserProfile {
  name: string;
  pronouns?: string;
  timezone?: string;
  locale?: string;
  addressAs?: string;
  body: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ─── previously.md identity parser ───────────────────────────────────────

/**
 * Parse the "User identity" section from a previously.md body.
 * Extracts structured fields from Chinese-format identity beliefs.
 */
function parseIdentityFromPreviously(previouslyContent: string): UserProfile | null {
  // Find the User identity section
  const identityMatch = previouslyContent.match(
    /## User identity[^\n]*\n([\s\S]*?)(?=\n## |\n*$)/,
  );
  if (!identityMatch) return null;

  const section = identityMatch[1].trim();
  if (!section || section.includes("_No beliefs yet._")) return null;

  const profile: UserProfile = { name: "", body: "" };
  const bodyLines: string[] = [];

  // Parse each belief line
  const lines = section.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("(")) continue; // skip annotations

    // Remove leading bullet
    const belief = trimmed.replace(/^-\s*/, "").trim();
    if (!belief) continue;

    // Extract name from "自称 X" or "叫 X" patterns
    const selfNameMatch = belief.match(/自称\s*(.+?)(?:，|,|可用|$)/);
    if (selfNameMatch) {
      profile.name = profile.name || selfNameMatch[1].trim();
    }

    // Extract addressAs from "可用 X 称呼"
    const addressMatch = belief.match(/可用\s*(.+?)\s*称呼/);
    if (addressMatch) {
      profile.addressAs = profile.addressAs || addressMatch[1].trim();
    }

    // Extract name from "Name: X" or "名字: X"
    const nameMatch = belief.match(/(?:Name|名字|姓名)[：:]\s*(.+)/i);
    if (nameMatch) {
      profile.name = profile.name || nameMatch[1].trim();
    }

    // Extract pronouns
    const pronounMatch = belief.match(/(?:Pronouns|代词|人称)[：:]\s*(.+)/i);
    if (pronounMatch && !profile.pronouns) {
      profile.pronouns = pronounMatch[1].trim();
    }

    bodyLines.push(belief);
  }

  profile.body = bodyLines.join("\n");
  return profile.name || profile.body ? profile : null;
}

// ─── Find previously.md ──────────────────────────────────────────────────

/**
 * Attempt to read a previously.md and extract identity facts.
 * Tries the well-known next-previously.md first (Pro's latest reflection),
 * then falls back to scanning recent slices.
 */
async function readPreviouslyIdentity(): Promise<UserProfile | null> {
  // Dynamic import to avoid circular dependency at module load time
  const { findMostRecentPreviously, readPreviously: readPrev } =
    await import("@/lib/episodic/manager");

  // Try next-previously.md first (Pro's latest reflection)
  try {
    const { readFileLocal: readLocal } = await import("@/lib/tools/local-fs");
    const nextPrev = await readLocal("memory/episodic/next-previously.md");
    if (nextPrev.trim()) {
      const parsed = parseIdentityFromPreviously(nextPrev);
      if (parsed) return parsed;
    }
  } catch {
    // No next-previously.md
  }

  // Fall back: scan for the most recent frozen previously.md
  try {
    const mostRecent = await findMostRecentPreviously();
    if (mostRecent) {
      const parsed = parseIdentityFromPreviously(mostRecent);
      if (parsed) return parsed;
    }
  } catch {
    // No previously.md available
  }

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function loadUserProfile(): Promise<UserProfile> {
  try {
    const fromPreviously = await readPreviouslyIdentity();
    if (fromPreviously) return fromPreviously;
  } catch {
    // previously.md unavailable — return empty default
  }

  return { name: "", body: "" };
}

/** The user's display name, or `fallback` ("You") when unset. */
export async function getUserName(fallback = "You"): Promise<string> {
  return (await loadUserProfile()).name || fallback;
}

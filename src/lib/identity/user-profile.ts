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
  /** Real nicknames/aliases the user goes by — NOT spelling variants of the name. */
  aliases?: string[];
  body: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ─── previously.md identity parser ───────────────────────────────────────

/**
 * Parse the identity section from a previously.md body.
 * v3: identity lives under the User profile section > `### Identity & background`.
 * Legacy v2: `## User identity`.
 * Extracts structured fields from Chinese-format identity beliefs.
 *
 * Exported so the housekeeping step can derive the "who you're assisting"
 * profile from the already-loaded previously content (pure parse, no I/O).
 */
export function parseIdentityFromPreviously(previouslyContent: string): UserProfile | null {
  // v4 card first (## Identity top-level section), then v3 (identity under the
  // User profile section), then the legacy v2 header.
  let identityMatch = previouslyContent.match(
    /## Identity[^\n]*\n([\s\S]*?)(?=\n## |\n*$)/,
  );
  if (!identityMatch) {
    identityMatch = previouslyContent.match(
      /### Identity & background[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n*$)/,
    );
  }
  if (!identityMatch) {
    identityMatch = previouslyContent.match(
      /## User identity[^\n]*\n([\s\S]*?)(?=\n## |\n*$)/,
    );
  }
  const section = identityMatch?.[1]?.trim();
  if (!section || section.includes("_No beliefs yet._")) return null;

  const profile: UserProfile = { name: "", body: "" };
  const bodyLines: string[] = [];

  // Parse each belief bullet. Meta lines (refs:/confidence:/evidence:/… and
  // legacy annotations) do NOT start with "- " and are skipped.
  const lines = section.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;

    // Remove leading bullet
    const belief = trimmed.replace(/^-\s*/, "").trim();
    if (!belief) continue;

    // Extract name from "自称 X" or "叫 X" patterns
    const selfNameMatch = belief.match(/自称\s*(.+?)(?:，|,|可用|$)/);
    if (selfNameMatch) {
      profile.name = profile.name || selfNameMatch[1].trim();
    }
    const calledNameMatch = belief.match(/叫\s*(\S+?)(?:，|,|（|\(|$)/);
    if (calledNameMatch) {
      profile.name = profile.name || calledNameMatch[1].trim();
    }

    // Extract addressAs from "可用 X 称呼"
    const addressMatch = belief.match(/可用\s*(.+?)\s*称呼/);
    if (addressMatch) {
      profile.addressAs = profile.addressAs || addressMatch[1].trim();
    }

    // Extract addressAs from the card's "Address them as: X" line.
    const addressLineMatch = belief.match(/Address them as[：:]\s*(.+)/i);
    if (addressLineMatch) {
      profile.addressAs = profile.addressAs || addressLineMatch[1].trim();
    }

    // Extract name from "Name: X" / "名字: X" / "姓名: X". Capture only up to
    // the first parenthetical — the model has been observed appending editorial
    // notes like "(also written …)" which are NOT part of the name (and the
    // updater now strips them mechanically; this is the defensive parser cut).
    const nameMatch = belief.match(/(?:Name|名字|姓名)[：:]\s*([^（()]+)/i);
    if (nameMatch) {
      profile.name = profile.name || nameMatch[1].trim();
    }

    // Extract alias/nickname from "Alias: X" / "别名：X" / "昵称：X" /
    // "Also known as: X". Multiple aliases may be comma/顿号 separated.
    const aliasMatch = belief.match(/(?:Alias|别名|昵称|Also known as)[：:]\s*(.+)/i);
    if (aliasMatch) {
      const aliases = aliasMatch[1]
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (aliases.length > 0) {
        profile.aliases = [...(profile.aliases ?? []), ...aliases];
      }
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

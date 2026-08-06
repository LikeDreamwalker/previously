/**
 * Shared turn-parsing utilities used by both tool executors and the evolution
 * workflow steps. Pure functions — no I/O, no side effects.
 */

/** Parse "YYYY-MM-DD-HHMM" into path segments. Returns null on invalid format. */
export function parseSliceId(sliceId: string): { y: string; m: string; d: string; hm: string } | null {
  const parts = sliceId.split("-");
  if (parts.length !== 4) return null;
  const [y, m, d, hm] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d) || !/^\d{4}$/.test(hm)) {
    return null;
  }
  return { y, m, d, hm };
}

/** Parsed turn from a core.md slice file. */
export interface ParsedTurn {
  /** Ordinal position of this turn in the slice (0, 1, 2, …). Stable and
   *  serializable — used by `range: { type: "turns" }` index matching. */
  index: number;
  /** The raw turn ID from the header ("1", "2", or base64url "a3fk2w").
   *  Absent on legacy slices whose header had no ID. */
  turnId?: string;
  header: string;   // "## Turn {id} — TIMESTAMP (role)"
  content: string;   // turn body text
  timestamp: string; // ISO 8601
}

/** Regex for turn headers: "## Turn {id} — TIMESTAMP (role)".
 *  Matches both legacy numeric IDs ("1", "2") and new base64url IDs ("a3fk2w").
 *  Separator is em-dash (U+2014), consistent with manager.ts serializeSlice. */
export const TURN_HEADER_RE = /^## Turn (\S+) — (\S+) \((\w+)\)/;

/**
 * Parse core.md content into frontmatter + array of parsed turns.
 * Frontmatter is everything before the first turn header.
 * `index` is the ORDINAL position (0-based), not the header ID — legacy
 * numeric IDs and base64url IDs both map to a stable ordinal, so index-based
 * range filtering works regardless of ID format.
 */
export function parseTurns(raw: string): { frontmatter: string; turns: ParsedTurn[] } {
  const lines = raw.split("\n");
  const turns: ParsedTurn[] = [];
  const frontmatterLines: string[] = [];
  let currentTurn: { turnId?: string; header: string; timestamp: string; contentLines: string[] } | null = null;
  let inFrontmatter = true;
  let turnOrdinal = 0;

  for (const line of lines) {
    const match = line.match(TURN_HEADER_RE);
    if (match) {
      if (currentTurn) {
        turns.push({
          index: turnOrdinal++,
          turnId: currentTurn.turnId,
          header: currentTurn.header,
          timestamp: currentTurn.timestamp,
          content: currentTurn.contentLines.join("\n").trimEnd(),
        });
      }
      currentTurn = {
        turnId: match[1],
        header: line,
        timestamp: match[2],
        contentLines: [],
      };
      inFrontmatter = false;
    } else if (inFrontmatter) {
      frontmatterLines.push(line);
    } else if (currentTurn) {
      currentTurn.contentLines.push(line);
    }
  }
  // Don't forget the last turn
  if (currentTurn) {
    turns.push({
      index: turnOrdinal,
      turnId: currentTurn.turnId,
      header: currentTurn.header,
      timestamp: currentTurn.timestamp,
      content: currentTurn.contentLines.join("\n").trimEnd(),
    });
  }

  return { frontmatter: frontmatterLines.join("\n").trimEnd(), turns };
}

/** Apply a range filter to parsed turns. Returns the filtered turns array. */
export function applyRange(
  turns: ParsedTurn[],
  range: { type: "turns" | "last" | "date"; indices?: number[]; count?: number; after?: string },
): ParsedTurn[] {
  switch (range.type) {
    case "turns": {
      if (!range.indices || range.indices.length === 0) return turns;
      const indexSet = new Set(range.indices);
      return turns.filter((t) => indexSet.has(t.index));
    }
    case "last": {
      const n = range.count ?? 3;
      return turns.slice(-n);
    }
    case "date": {
      if (!range.after) return turns;
      const afterMs = new Date(range.after).getTime();
      if (isNaN(afterMs)) return turns;
      return turns.filter((t) => new Date(t.timestamp).getTime() >= afterMs);
    }
    default:
      return turns;
  }
}

/** Reassemble filtered turns into markdown: frontmatter + selected turn headers & content. */
export function reassembleSlice(frontmatter: string, turns: ParsedTurn[]): string {
  const parts = [frontmatter];
  for (const t of turns) {
    parts.push(`\n${t.header}\n${t.content}`);
  }
  return parts.join("\n");
}

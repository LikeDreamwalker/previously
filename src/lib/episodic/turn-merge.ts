/**
 * Turn-merge helper for the finalize-turn write-conflict self-heal.
 *
 * When a turn's batched commit loses a non-fast-forward race on GitHub
 * (another turn or process committed to the branch first), the queued slice
 * file was computed from a STALE base. Turns are append-only, so the merge is
 * mechanical: re-parse the remote core.md, append every local turn the remote
 * is missing (keyed by turnId), union the tag/loop pointers, and re-serialize.
 * The caller swaps the merged content into the batch and retries the commit.
 *
 * Pure module — no I/O — so it is unit-testable and safe to import anywhere.
 */
import { parseSlice, serializeSlice } from "./manager";
import type { TimeSlice, Turn } from "./types";

/**
 * Identity key for a turn. New turns carry a turnId; legacy numeric-labeled
 * turns parsed from old files have none, so fall back to a content fingerprint.
 */
function turnKey(turn: Turn): string {
  return (
    turn.turnId ??
    `${turn.timestamp}|${turn.role}|${turn.content.slice(0, 64)}`
  );
}

/**
 * Merge `local`'s turns into the remote slice body. Returns the re-serialized
 * slice. The REMOTE frontmatter wins (it may carry state — close marking,
 * status — written after our snapshot was computed); only turns, tags and
 * loop pointers are unioned in.
 */
export function mergeTurnsWithRemote(
  remoteRaw: string,
  local: TimeSlice,
): string {
  const remote = parseSlice(remoteRaw);

  const seen = new Set(remote.turns.map(turnKey));
  for (const turn of local.turns) {
    const key = turnKey(turn);
    if (seen.has(key)) continue;
    seen.add(key);
    remote.turns.push(turn);
  }

  for (const tag of local.tags) {
    if (!remote.tags.includes(tag)) remote.tags.push(tag);
  }
  for (const loopId of local.loops) {
    if (!remote.loops.includes(loopId)) remote.loops.push(loopId);
  }

  return serializeSlice(remote);
}

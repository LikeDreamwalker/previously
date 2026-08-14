"use server";

import { getRun } from "workflow/api";

/**
 * Whether a durable chat run is still in flight — the ONLY signal that
 * justifies restoring a conversation on arrival. The live view restores
 * in-flight work; a terminal run (completed / failed / cancelled) means the
 * turn's content already lives in its slice — reading it is the timeline's
 * job, and continuity is the arrival briefing's job.
 *
 * The client never guesses this from timestamps or silence windows; it asks
 * here. Unknown/expired runs answer false.
 */
export async function isChatRunActive(runId: string): Promise<boolean> {
  try {
    const status = await getRun(runId).status;
    return status === "pending" || status === "running";
  } catch {
    return false;
  }
}

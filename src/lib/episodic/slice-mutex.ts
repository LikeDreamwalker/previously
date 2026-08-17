/**
 * In-process per-key async mutex for episodic turn persistence.
 *
 * Two chat turns running in the SAME process (local dev, a single-node
 * deployment) otherwise interleave their read-modify-write cycles on the same
 * slice files and monthly index, and can flush each other's batched writes.
 * Serializing per slice id removes that whole class of race for single-process
 * deployments. Cross-PROCESS conflicts (serverless) are unaffected by this and
 * are healed at commit time instead (see finalizeTurn's flush retry).
 *
 * Workflow-step safety: the lock is acquired and released INSIDE one
 * `"use step"` invocation — it is never held across step boundaries, so the
 * deterministic-replay constraint is untouched. The map entry is dropped as
 * soon as the tail settles, so long-lived processes don't accumulate keys.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` holding the lock for `key`. Calls with the same key are serialized
 * in arrival order; calls with different keys run concurrently.
 */
export function withSliceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const result = prev.then(fn);
  // The tail never rejects, so a failed holder releases the queue.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

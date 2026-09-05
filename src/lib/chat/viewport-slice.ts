/**
 * The slice currently at the top of the chat stream's viewport — published by
 * ChatPage (the stream reports its top visible item), read by the header mode
 * switcher when it builds the `/timeline?at=…` href so the 3D camera docks at
 * the slice the user was reading (v0.10 §6.1 双向上下文携带). Same module-level
 * discipline as slice-jump.ts / turn-busy.ts: no provider, no dependency.
 *
 * `null` = the viewer is at the live bottom ("now") or nothing is published —
 * the switcher then opens the timeline without an `at` anchor.
 */

let viewportSlice: string | null = null;

/** ChatPage publishes on every top-item change; pass null on unmount. */
export function setViewportSlice(sliceId: string | null): void {
  viewportSlice = sliceId;
}

/** The mode switcher reads this at click time (never reactive on purpose). */
export function getViewportSlice(): string | null {
  return viewportSlice;
}

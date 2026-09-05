/**
 * The card-style horizontal swipe → mode switch decision (v0.10 §5.2/§6.1
 * Rev 2) — pure, no React.
 *
 * From chat mode a LEFT drag is the candidate (content slides left, the
 * timeline comes in from the right); a right drag has nowhere to go and
 * always rubber-bands back. The drag COMMITS past a displacement threshold
 * or on a fast fling (velocity), else the card springs home.
 */

/** Committed once the card traveled this far left (px). */
export const MODE_SWITCH_DISTANCE_PX = 120;
/** …or when flung left at at least this speed (px/s, motion's velocity.x). */
export const MODE_SWITCH_VELOCITY_PX_S = 500;

/** Should a released drag commit the chat → timeline switch? */
export function shouldCommitModeSwitch(
  offsetX: number,
  velocityX: number,
): boolean {
  return (
    offsetX <= -MODE_SWITCH_DISTANCE_PX ||
    velocityX <= -MODE_SWITCH_VELOCITY_PX_S
  );
}

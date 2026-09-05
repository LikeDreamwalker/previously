/**
 * Node-focus state machine for the 3D timeline (doc/design/v0.10.0 §5.2).
 *
 * Two modes: "fly" (L0–L2 — scrolling travels through time, zooming changes
 * information density) and "focus" (a node is opened — its glass card hangs
 * beside the bead, and at L3 its turn preview strip). Pure and
 * framework-free so the semantics stay unit-testable.
 *
 * Invariants:
 * - At most one node is focused at a time: FOCUS replaces any open focus.
 * - `turnPos` is retained for turn-stepping semantics (SCROLL/GOTO_TURN) —
 *   Rev 2 renders turns as a DOM strip, so the scene only uses FOCUS/EXIT.
 * - SCROLL/GOTO_TURN outside focus mode are no-ops.
 */

export interface FlyState {
  mode: "fly";
}

export interface FocusedState {
  mode: "focus";
  sliceId: string;
  /** Fractional turn position, clamped to [0, turnCount-1] by events. */
  turnPos: number;
}

export type FocusState = FlyState | FocusedState;

export type FocusEvent =
  | { type: "FOCUS"; sliceId: string }
  | { type: "EXIT" }
  | { type: "SCROLL"; delta: number; turnCount: number }
  | { type: "GOTO_TURN"; index: number; turnCount: number };

export const INITIAL_FOCUS_STATE: FocusState = { mode: "fly" };

function clampTurn(pos: number, turnCount: number): number {
  const max = Math.max(0, turnCount - 1);
  return Math.min(Math.max(pos, 0), max);
}

export function focusReducer(state: FocusState, event: FocusEvent): FocusState {
  switch (event.type) {
    case "FOCUS":
      return { mode: "focus", sliceId: event.sliceId, turnPos: 0 };
    case "EXIT":
      return INITIAL_FOCUS_STATE;
    case "SCROLL":
      if (state.mode !== "focus") return state;
      return { ...state, turnPos: clampTurn(state.turnPos + event.delta, event.turnCount) };
    case "GOTO_TURN":
      if (state.mode !== "focus") return state;
      return { ...state, turnPos: clampTurn(event.index, event.turnCount) };
  }
}

/** The integer current turn for the panel / fragment highlight, or null. */
export function currentTurnIndex(
  state: FocusState,
  turnCount: number,
): number | null {
  if (state.mode !== "focus" || turnCount <= 0) return null;
  return Math.round(clampTurn(state.turnPos, turnCount));
}

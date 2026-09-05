/**
 * Trailing-edge debounce as a plain factory (no React), so the timing logic is
 * unit-testable with fake timers. The command palette uses it for
 * search-as-you-type; `cancel` on unmount so a late fire never setStates a
 * dead component.
 */
export interface Debounced<A extends unknown[]> {
  call(...args: A): void;
  cancel(): void;
}

export function createDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call(...args: A) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

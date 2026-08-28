"use client";

import { useSyncExternalStore } from "react";

/**
 * Cross-component "a chat turn is in flight" signal. ChatPage publishes its
 * isLoading here; the header's settings entry subscribes and disables itself
 * while a turn is running (engine/model settings must not change mid-turn).
 * Module-level store + useSyncExternalStore — no dependency, no provider.
 */

let busy = false;
const listeners = new Set<() => void>();

export function setTurnBusy(value: boolean): void {
  if (busy === value) return;
  busy = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a chat turn is currently in flight (submitted or streaming). */
export function useTurnBusy(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => busy,
    () => false,
  );
}

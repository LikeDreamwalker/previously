"use client";

import { useEffect, useState } from "react";

/**
 * Client-side shape of a catalog entry from GET /api/models. In demo mode the
 * route returns only the locked model (see src/lib/demo/model-lock).
 */
export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  supportsThinking: boolean;
  supportsVision: boolean;
  maxTokens: number;
  defaultThinking: boolean;
  defaultEffort: "low" | "medium" | "high";
}

// Module-level shared promise — the model selector and the chat page both need
// the catalog; fetch it once per page load.
let pending: Promise<AvailableModel[]> | null = null;

function fetchModels(): Promise<AvailableModel[]> {
  pending ??= fetch("/api/models")
    .then((r) => r.json())
    .then((data) => (data.models ?? []) as AvailableModel[])
    .catch(() => {
      pending = null; // allow a retry after a transient failure
      return [] as AvailableModel[];
    });
  return pending;
}

/** The deployment's available models (server-side catalog, env-key-gated). */
export function useAvailableModels(): AvailableModel[] {
  const [models, setModels] = useState<AvailableModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchModels().then((list) => {
      if (!cancelled) setModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}

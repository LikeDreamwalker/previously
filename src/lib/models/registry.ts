/**
 * Model registry — multi-provider model definitions with capabilities.
 */
export interface ModelCapabilities {
  thinking: boolean;
  vision: boolean;
  maxTokens: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: "deepseek" | "anthropic" | "openai";
  capabilities: ModelCapabilities;
}

export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  },
];

export function resolveModelId(id: string): string {
  return id;
}

export function getModel(id: string): ModelConfig | undefined {
  return DEFAULT_MODELS.find((m) => m.id === id);
}

export function getDefaultModel(): ModelConfig {
  return DEFAULT_MODELS[0];
}

export function modelSupportsThinking(id: string): boolean {
  return getModel(id)?.capabilities.thinking ?? false;
}

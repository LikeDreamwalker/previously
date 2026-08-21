"use client";

import { useState, useRef, useCallback, useEffect, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Square, Paperclip, X, Settings, FlaskConical, Zap } from "lucide-react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Link } from "@/i18n/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelSelector, type ModelDefaults } from "./model-selector";

/**
 * Effort tiers depend on the model family. DeepSeek's native tiers are "low"
 * and "high" — "medium" is not meaningfully distinct (V4 Pro promotes it
 * server-side), so the cycle offers just two levels there. Anthropic and
 * OpenAI-compatible providers expose all three. "medium" stays in the type for
 * stored configs / other providers; on DeepSeek a stored "medium" snaps to
 * "high" (it has no native medium tier).
 */
type EffortLevel = "low" | "medium" | "high";

const FULL_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const DEEPSEEK_EFFORT_LEVELS = ["low", "high"] as const;

/** Effort tiers available for a model id — DeepSeek collapses to low/high. */
function effortLevelsFor(modelId: string): readonly EffortLevel[] {
  return modelId.startsWith("deepseek")
    ? DEEPSEEK_EFFORT_LEVELS
    : FULL_EFFORT_LEVELS;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Stored effort may be outside the model's tier set — snap to a valid tier. */
function normalizeEffort(level: EffortLevel, modelId: string): EffortLevel {
  const levels = effortLevelsFor(modelId);
  return (levels as readonly EffortLevel[]).includes(level)
    ? level
    : levels[levels.length - 1];
}

/** Display label for the model's effective tier (a DeepSeek "medium" → "High"). */
function effortLabel(level: EffortLevel, modelId: string): string {
  return EFFORT_LABELS[normalizeEffort(level, modelId)];
}

interface ChatInputProps {
  onSubmit: (message: string, images: File[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  onDemo?: () => void;
  demoRunning?: boolean;
  /** Whether the selected model accepts image inputs (from /api/models). */
  visionEnabled?: boolean;
  /** Demo mode: model + thinking intensity are pinned server-side. */
  demoLocked?: boolean;
  // Model + thinking/effort — owned by ChatPage so the request body and the
  // toolbar stay in sync. ChatInput renders the controls, ChatPage persists.
  currentModelId: string;
  currentEffort: EffortLevel;
  thinking: boolean;
  onModelChange: (modelId: string, defaults: ModelDefaults) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onThinkingChange: (thinking: boolean) => void;
}

export function ChatInput({
  onSubmit,
  isLoading,
  onStop,
  onDemo,
  demoRunning = false,
  visionEnabled = false,
  demoLocked = false,
  currentModelId,
  currentEffort,
  thinking,
  onModelChange,
  onEffortChange,
  onThinkingChange,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const [value, setValue] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const { images, removeImage, clearImages, handlePaste, handleDrop, handleDragOver } = useImageAttachments();

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "24px";
    el.style.height = Math.min(el.scrollHeight, 72) + "px";
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    if (isLoading) return;

    onSubmit(trimmed, visionEnabled ? images : []);
    setValue("");
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "24px";
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    resizeTextarea();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const valid = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024
    );
    if (valid.length > 0) {
      // manually add valid files
      const dt = new DataTransfer();
      valid.forEach((f) => dt.items.add(f));
      const syntheticEvent = { clipboardData: dt } as unknown as React.ClipboardEvent;
      handlePaste(syntheticEvent);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    setIsDragOver(false);
    handleDrop(e);
  };

  const cycleEffort = useCallback(() => {
    const levels = effortLevelsFor(currentModelId);
    const idx = levels.indexOf(normalizeEffort(currentEffort, currentModelId));
    const next = levels[(idx + 1) % levels.length];
    onEffortChange(next);
  }, [currentEffort, currentModelId, onEffortChange]);

  const hasContent = value.trim().length > 0 || images.length > 0;

  return (
    <div
      className={`overflow-hidden rounded-2xl bg-muted transition-colors ${isDragOver ? "ring-2 ring-blue-500/50" : ""}`}
      onPaste={visionEnabled ? handlePaste : undefined}
      onDrop={visionEnabled ? onDrop : undefined}
      onDragOver={visionEnabled ? onDragOver : undefined}
      onDragLeave={visionEnabled ? onDragLeave : undefined}
    >
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-4 pt-3 flex-wrap">
          {images.map((file, i) => (
            <div key={i} className="relative group">
              <img
                src={URL.createObjectURL(file)}
                alt={file.name}
                className="h-16 w-16 rounded-lg object-cover border border-border"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-muted-foreground/80 text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <div className="px-4 pb-2 pt-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={t("placeholder")}
          disabled={isLoading || demoRunning}
          rows={1}
          className="w-full resize-none overflow-y-auto bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none text-sm"
          style={{ minHeight: "24px", maxHeight: "72px" }}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        {/* Left side */}
        <div className="flex min-w-0 items-center gap-2">
          {/* Attach — gated on the selected model's vision capability */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled={!visionEnabled}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              }
            />
            <TooltipContent side="top">
              {visionEnabled ? t("attach") : t("attachUnsupported")}
            </TooltipContent>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            accept="image/*"
          />

          {/* Mock demo — visual showcase of all render capabilities */}
          {onDemo && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onDemo}
                    disabled={demoRunning || isLoading}
                    className={`h-7 w-7 rounded-full transition-colors flex items-center justify-center ${
                      demoRunning
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10"
                    } disabled:opacity-30`}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                  </button>
                }
              />
              <TooltipContent side="top">
                {demoRunning ? "Demo running…" : "Render demo"}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Model selector — NEW */}
          <ModelSelector
            currentModelId={currentModelId}
            thinking={thinking}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
          />

          {/* Thinking intensity — pinned in demo mode (demoLocked) */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={cycleEffort}
                  disabled={isLoading || demoRunning || demoLocked}
                  className="h-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center gap-1 px-2 disabled:opacity-30"
                >
                  <Zap className="h-3 w-3" />
                  <span className="text-[10px] font-medium leading-none">
                    {mounted ? effortLabel(currentEffort, currentModelId) : "High"}
                  </span>
                </button>
              }
            />
            <TooltipContent side="top">
              {demoLocked
                ? t("effortLocked")
                : `Thinking: ${effortLabel(currentEffort, currentModelId)} — click to cycle`}
            </TooltipContent>
          </Tooltip>

          {/* Settings */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  href="/settings"
                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Link>
              }
            />
            <TooltipContent side="top">{t("settingsTooltip")}</TooltipContent>
          </Tooltip>
        </div>

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-1">
          {isLoading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="h-8 w-8 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 flex items-center justify-center"
              title={t("stopTooltip")}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              onClick={(e) => handleSubmit(e as unknown as FormEvent)}
              disabled={!hasContent}
              className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-30 ${
                hasContent
                  ? "bg-brand text-white hover:bg-brand/90"
                  : "bg-primary text-primary-foreground"
              }`}
              title={t("sendTooltip")}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

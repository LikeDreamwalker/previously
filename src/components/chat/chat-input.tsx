"use client";

import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Square, Paperclip, X, Settings, FlaskConical } from "lucide-react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Link } from "@/i18n/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelSelector } from "./model-selector";

interface ChatInputProps {
  onSubmit: (message: string, images: File[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  onDemo?: () => void;
  demoRunning?: boolean;
  /** Whether the selected model accepts image inputs (from /api/models). */
  visionEnabled?: boolean;
  // Model selection — owned by ChatPage so the request body and the toolbar
  // stay in sync. ChatInput renders the control, ChatPage persists.
  // Thinking is always ON at low effort (pinned server-side in start-turn.ts);
  // there is no thinking/effort UI anymore.
  currentModelId: string;
  onModelChange: (modelId: string) => void;
}

export function ChatInput({
  onSubmit,
  isLoading,
  onStop,
  onDemo,
  demoRunning = false,
  visionEnabled = false,
  currentModelId,
  onModelChange,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const [value, setValue] = useState("");
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
            onModelChange={onModelChange}
          />

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

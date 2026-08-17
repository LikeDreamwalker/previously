"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, ChevronUp, Copy, FileCode2 } from "lucide-react";

/** Blocks longer than this get collapsed behind a "show all" toggle. */
const COLLAPSE_LINES = 20;
const COLLAPSED_MAX_HEIGHT = 320;

interface CodeBlockProps {
  language?: string;
  /** Raw code text — used for the clipboard and the collapse line count. */
  code: string;
  /** When the message is still streaming in, show a subtle highlight. */
  isStreaming?: boolean;
  /** Optional filename parsed from the fence meta (```ts:app/page.tsx). */
  filename?: string;
  /**
   * Pre-rendered (syntax-highlighted) content. Falls back to the raw
   * `code` string when absent.
   */
  children?: React.ReactNode;
}

export function CodeBlock({ language, code, isStreaming = false, filename, children }: CodeBlockProps) {
  const t = useTranslations("chat.code");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lineCount = code === "" ? 0 : code.split("\n").length;
  const collapsible = !isStreaming && lineCount > COLLAPSE_LINES;
  const collapsed = collapsible && !expanded;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block relative group my-3 rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/50 border-b border-border">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] leading-4 text-brand font-mono font-medium">
            {language ?? t("fallbackLanguage")}
          </span>
          {filename && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] font-mono text-muted-foreground">
              <FileCode2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{filename}</span>
            </span>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[28px] min-w-[28px] justify-center"
          title={copied ? t("copiedTooltip") : t("copyTooltip")}
        >
          <span className="relative block h-3.5 w-3.5">
            <Copy
              className={`absolute inset-0 h-3.5 w-3.5 transition-opacity duration-150 ${copied ? "opacity-0" : "opacity-100"}`}
            />
            <Check
              className={`absolute inset-0 h-3.5 w-3.5 text-green-500 transition-opacity duration-150 ${copied ? "opacity-100" : "opacity-0"}`}
            />
          </span>
        </button>
      </div>
      {/* Code */}
      <div className="relative">
        <pre
          style={
            collapsed ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined
          }
          className={`overflow-x-auto p-4 text-[13px] leading-6 bg-muted/20 transition-colors duration-500 ${
            collapsed ? "overflow-y-hidden" : ""
          } ${isStreaming ? "bg-brand/[0.04]" : ""}`}
        >
          <code className={`language-${language ?? "text"}`}>{children ?? code}</code>
        </pre>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background/95 to-transparent" />
        )}
      </div>
      {collapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center gap-1 border-t border-border bg-muted/50 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              {t("collapse")}
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              {t("expandAll", { count: lineCount })}
            </>
          )}
        </button>
      )}
    </div>
  );
}

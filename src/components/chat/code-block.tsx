"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  language?: string;
  code: string;
  /** When the message is still streaming in, show a subtle highlight. */
  isStreaming?: boolean;
}

export function CodeBlock({ language, code, isStreaming = false }: CodeBlockProps) {
  const t = useTranslations("chat.code");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3 rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-muted/50 border-b border-border">
        <span className="text-xs text-muted-foreground font-mono">
          {language ?? t("fallbackLanguage")}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[28px] min-w-[28px] justify-center"
          title={copied ? t("copiedTooltip") : t("copyTooltip")}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {/* Code */}
      <pre
        className={`overflow-x-auto p-4 text-xs leading-relaxed bg-muted/20 transition-colors duration-500 ${
          isStreaming ? "bg-primary/[0.03]" : ""
        }`}
      >
        <code className={`language-${language ?? "text"}`}>{code}</code>
      </pre>
    </div>
  );
}

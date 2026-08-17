import { Children, cloneElement, isValidElement } from "react";
import { useTranslations } from "next-intl";
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  AlertTriangle,
  AlertOctagon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Extract raw text from React children — rehype-highlight wraps tokens in <span>s. */
export function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (isValidElement(children))
    return extractText(
      (children.props as { children?: React.ReactNode }).children,
    );
  return "";
}

/* ── GitHub-style alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION] ── */

export type AdmonitionType = "note" | "tip" | "important" | "warning" | "caution";

const MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

const ADMONITION_STYLE: Record<
  AdmonitionType,
  { border: string; label: string; Icon: LucideIcon }
> = {
  note: {
    border: "border-brand/50",
    label: "text-brand",
    Icon: Info,
  },
  tip: {
    border: "border-green-500/50",
    label: "text-green-600 dark:text-green-400",
    Icon: Lightbulb,
  },
  important: {
    border: "border-purple-500/50",
    label: "text-purple-600 dark:text-purple-400",
    Icon: MessageSquareWarning,
  },
  warning: {
    border: "border-amber-500/50",
    label: "text-amber-600 dark:text-amber-400",
    Icon: AlertTriangle,
  },
  caution: {
    border: "border-red-500/50",
    label: "text-red-600 dark:text-red-400",
    Icon: AlertOctagon,
  },
};

function Admonition({
  type,
  className,
  children,
}: {
  type: AdmonitionType;
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("markdown.alert");
  const { border, label, Icon } = ADMONITION_STYLE[type];
  return (
    <div
      className={cn(
        "rounded-r-lg border-l-2 bg-muted/40 px-4 py-2.5 [&_p:first-child]:mt-0",
        border,
        className,
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-sm font-semibold", label)}>
        <Icon className="h-4 w-4" />
        {t(type)}
      </div>
      <div className="mt-1 text-muted-foreground">{children}</div>
    </div>
  );
}

/**
 * Remove the leading `[!TYPE]` marker from a paragraph's children. The
 * marker can be split across several text nodes — mdast parses `[!NOTE]`
 * as an undefined link reference, which to-hast reverts to "[" + "!NOTE"
 * + "]" — so walk text nodes until `markerLength` chars are consumed, then
 * drop the line break that follows the marker.
 */
function stripMarker(children: React.ReactNode, markerLength: number): React.ReactNode {
  let remaining = markerLength;
  let trimBreak = false;

  function walk(node: React.ReactNode): React.ReactNode {
    if (typeof node === "string") {
      if (remaining > 0) {
        const stripped = node.length > remaining ? node.slice(remaining) : "";
        remaining = Math.max(0, remaining - node.length);
        if (remaining === 0) trimBreak = true;
        return stripped;
      }
      if (trimBreak) {
        trimBreak = false;
        return node.replace(/^[ \t]*\n[ \t]*/, "");
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    return node;
  }

  return walk(children);
}

const DEFAULT_BLOCKQUOTE_CLASS =
  "rounded-r-lg border-l-2 border-brand/50 bg-muted/40 px-4 py-2.5 text-muted-foreground [&>p:first-child]:mt-0";

/**
 * Blockquote renderer with GitHub-alert detection. A quote whose first
 * paragraph starts with `[!TYPE]` becomes a typed Admonition (marker
 * stripped); anything else renders as a plain styled blockquote.
 *
 * Hook-free and directive-free — safe in both RSC (docs) and client (chat).
 */
export function MarkdownBlockquote({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const arr = Children.toArray(children);
  // Whitespace text nodes can precede the first element — find the first
  // real element (normally the opening <p>) and test it for the marker.
  const firstIndex = arr.findIndex(isValidElement);
  const first = firstIndex >= 0 ? arr[firstIndex] : undefined;

  if (isValidElement<{ children?: React.ReactNode }>(first)) {
    const match = MARKER_RE.exec(extractText(first.props.children));
    if (match) {
      const type = match[1].toLowerCase() as AdmonitionType;
      const stripped = stripMarker(first.props.children, match[0].length);
      const next = arr.slice();
      next[firstIndex] = cloneElement(first, undefined, stripped);
      return (
        <Admonition type={type} className={className}>
          {next}
        </Admonition>
      );
    }
  }

  return (
    <blockquote className={cn(DEFAULT_BLOCKQUOTE_CLASS, className)}>
      {children}
    </blockquote>
  );
}

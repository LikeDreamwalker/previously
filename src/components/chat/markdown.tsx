import { memo, isValidElement, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import type { Components } from "react-markdown";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { CodeBlock } from "./code-block";
import { cn } from "@/lib/utils";

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (isValidElement(children))
    return extractText(
      (children.props as { children?: React.ReactNode }).children,
    );
  return "";
}

/** Factory for streaming-safe components. */
function createComponents(isStreaming: boolean): Components {
  let liCounter = 0;

  const listItem = (children: React.ReactNode) => {
    const index = liCounter++;
    return (
      <li
        style={
          isStreaming
            ? ({ "--stagger-index": index } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </li>
    );
  };

  return {
    /* ── Code (inline + block) ──────────────────────────────────── */
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className ?? "");
      const codeStr = extractText(children).replace(/\n$/, "");

      if (!match) {
        return (
          <code {...props}>
            {children}
          </code>
        );
      }

      return (
        <CodeBlock
          language={match[1]}
          code={codeStr}
          isStreaming={isStreaming}
        />
      );
    },

    pre({ children }) {
      return <>{children}</>;
    },

    /* ── Tables → shadcn Table ──────────────────────────────────── */
    table({ children }) {
      return (
        <div className="typeset-scroll">
          <Table>{children}</Table>
        </div>
      );
    },
    thead({ children }) {
      return <TableHeader>{children}</TableHeader>;
    },
    tbody({ children }) {
      return <TableBody>{children}</TableBody>;
    },
    tr({ children }) {
      return <TableRow>{children}</TableRow>;
    },
    th({ children }) {
      return <TableHead>{children}</TableHead>;
    },
    td({ children }) {
      return <TableCell>{children}</TableCell>;
    },

    /* ── Links ──────────────────────────────────────────────────── */
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },

    /* ── Lists ──────────────────────────────────────────────────── */
    li({ children }) {
      return listItem(children);
    },
    ul({ children }) {
      liCounter = 0;
      return <ul>{children}</ul>;
    },
    ol({ children }) {
      liCounter = 0;
      return <ol>{children}</ol>;
    },

    /* ── Blockquote → shadcn Alert ──────────────────────────────── */
    blockquote({ children }) {
      // Extract plain text for the description — children may contain
      // nested paragraphs, which AlertDescription handles naturally.
      return (
        <Alert variant="default" className="my-0">
          <AlertDescription className="text-muted-foreground">
            {children}
          </AlertDescription>
        </Alert>
      );
    },

    /* ── Horizontal rule → shadcn Separator ─────────────────────── */
    hr() {
      return <Separator />;
    },
  };
}

interface MarkdownRendererProps {
  content: string;
  /** When true, block-level children animate in as they arrive. */
  isStreaming?: boolean;
}

/**
 * Memoized react-markdown renderer.
 *
 * Uses typeset CSS (typeset.css) for all typography rhythm — heading
 * sizes, paragraph spacing, list indentation, inline code, etc. — and
 * shadcn/ui components (Table, Alert, Separator) for structural elements.
 *
 * Stable components are created once with streaming always enabled, so
 * react-markdown never rebuilds the component tree when `isStreaming`
 * toggles (which would cause DOM churn → layout shift → sibling animations
 * to replay). The stagger CSS property is harmless when the
 * `.streaming-content` class is absent — the keyframes never run.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
}: MarkdownRendererProps) {
  const comps = useMemo(() => createComponents(true), []);

  return (
    <div
      className={cn(
        "typeset typeset-chat max-w-none break-words",
        isStreaming && "streaming-content",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeSlug]}
        components={comps}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

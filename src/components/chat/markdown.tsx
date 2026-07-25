import { memo, isValidElement, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import type { Components } from "react-markdown";
import { CodeBlock } from "./code-block";
import { cn } from "@/lib/utils";

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (isValidElement(children)) return extractText((children.props as { children?: React.ReactNode }).children);
  return "";
}

/** Factory for components that need a per-render list-item counter for stagger delays. */
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
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const codeStr = extractText(children).replace(/\n$/, "");

    // Inline code
    if (!match) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono" {...props}>
          {children}
        </code>
      );
    }

    // Block code
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
  table({ children }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="min-w-full border-collapse border border-border text-xs">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border px-3 py-1.5 bg-muted/50 text-left font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border border-border px-3 py-1.5">{children}</td>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand hover:underline"
      >
        {children}
      </a>
    );
  },
  li({ children }) {
    return listItem(children);
  },
  ul({ children }) {
    liCounter = 0; // reset per-list
    return <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>;
  },
  ol({ children }) {
    liCounter = 0; // reset per-list
    return <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-4 border-border" />;
  },
  };
}

interface MarkdownRendererProps {
  content: string;
  /** When true, block-level children animate in as they arrive. */
  isStreaming?: boolean;
}

/**
 * Memoized on `content` + `isStreaming` — react-markdown + rehype-highlight is
 * expensive and synchronous, so without this it re-highlights on every parent
 * re-render (every streaming delta / tool-state change). Stable text never
 * re-highlights.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
}: MarkdownRendererProps) {
  // Always use streaming-capable components so react-markdown doesn't
  // rebuild the entire tree when `isStreaming` toggles (which would cause
  // DOM churn → layout shifts → sibling ToolLayout animations to replay).
  // The stagger CSS custom property is harmless when `.streaming-content`
  // is absent — the animation keyframes simply never run.
  const comps = useMemo(() => createComponents(true), []);

  return (
    <div
      className={cn(
        "prose-sm dark:prose-invert max-w-none break-words [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-2",
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

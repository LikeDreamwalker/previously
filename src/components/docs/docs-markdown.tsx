import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import type { Components } from "react-markdown";
import { isValidElement } from "react";
import { CodeBlock } from "@/components/chat/code-block";
import { Link } from "@/i18n/navigation";
import { DocPreview } from "./doc-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** Extract raw text from React children — rehype-highlight wraps tokens in <span>s. */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (isValidElement(children)) return extractText((children.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Docs-tuned Markdown renderer. Reuses the chat `CodeBlock`, routes internal
 * links through next-intl `Link`, and turns a ```preview\ndemo: <id>``` fence
 * into a live component preview (`DocPreview`). Larger typographic scale than
 * the chat renderer since docs are read, not skimmed.
 */
const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const lang = match?.[1];
    const codeStr = extractText(children).replace(/\n$/, "");

    if (lang === "preview") {
      const demoId = /demo:\s*([\w-]+)/.exec(codeStr)?.[1] ?? "";
      return <DocPreview id={demoId} />;
    }

    if (lang === "alert") {
      return (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{codeStr}</AlertDescription>
        </Alert>
      );
    }

    if (!match) {
      return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" {...props}>
          {children}
        </code>
      );
    }

    return <CodeBlock language={lang ?? "text"} code={codeStr} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    if (href && href.startsWith("/")) {
      return (
        <Link href={href} className="text-brand-600 dark:text-brand-400 hover:underline">
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-600 dark:text-brand-400 hover:underline"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto">
        <table className="min-w-full border-collapse border border-border text-sm">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border bg-muted/50 px-3 py-2 text-left font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-border px-3 py-2">{children}</td>;
  },
  ul({ children }) {
    return <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-4 border-l-2 border-primary/40 pl-4 italic text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-8 border-border" />;
  },
};

export function DocsMarkdown({ content }: { content: string }): React.ReactElement {
  return (
    <div className="max-w-none text-sm leading-relaxed text-foreground/90 [&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_p]:my-3 [&_h1]:scroll-mt-16 [&_h2]:scroll-mt-16 [&_h3]:scroll-mt-16">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeSlug]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

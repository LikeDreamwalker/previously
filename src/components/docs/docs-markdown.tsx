import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import type { Components } from "react-markdown";
import { CodeBlock } from "@/components/chat/code-block";
import { MermaidBlock } from "@/components/chat/mermaid-block";
import {
  MarkdownBlockquote,
  extractText,
} from "@/components/markdown/admonition";
import { Link } from "@/i18n/navigation";
import { DocPreview } from "./doc-preview";
import { remarkCodeFilename } from "@/lib/markdown/remark-code-filename";

/** Parse a fence meta string (```ts:app/page.tsx or ```ts filename="x.ts"). */
function parseFilename(meta: unknown): string | undefined {
  if (typeof meta !== "string" || !meta.trim()) return undefined;
  const m = /(?:^|\s)(?:filename=)?["']?([\w./-]+\.[A-Za-z0-9]+)["']?/.exec(meta);
  return m?.[1];
}

const linkClass =
  "text-brand-600 underline decoration-brand/35 underline-offset-3 transition-colors hover:text-brand-700 hover:decoration-current dark:text-brand-400 dark:hover:text-brand-300";

/**
 * Docs-tuned Markdown renderer. Reuses the chat `CodeBlock`, routes internal
 * links through next-intl `Link`, and turns a ```preview\ndemo: <id>``` fence
 * into a live component preview (`DocPreview`). Math renders via KaTeX,
 * ```mermaid fences as diagrams, `> [!TYPE]` quotes as GitHub-style alerts,
 * and headings get hover anchor links. Larger typographic scale than the
 * chat renderer since docs are read, not skimmed.
 */
const components: Components = {
  code({ className, children, node, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const lang = match?.[1];
    const codeStr = extractText(children).replace(/\n$/, "");

    if (lang === "preview") {
      const demoId = /demo:\s*([\w-]+)/.exec(codeStr)?.[1] ?? "";
      return <DocPreview id={demoId} />;
    }

    if (lang === "mermaid") {
      return <MermaidBlock code={codeStr} />;
    }

    if (!match) {
      return (
        <code
          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <CodeBlock
        language={lang ?? "text"}
        code={codeStr}
        filename={parseFilename(node?.data?.meta)}
      >
        {children}
      </CodeBlock>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children, className }) {
    // Heading anchors from rehype-autolink-headings keep their own styling.
    if (className?.includes("heading-anchor")) {
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    }
    if (href && href.startsWith("/")) {
      return (
        <Link href={href} className={linkClass}>
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b-2 border-border bg-muted/50 px-3 py-2 text-left font-semibold tracking-[0.01em]">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border-b border-border px-3 py-2">{children}</td>;
  },
  tbody({ children }) {
    return (
      <tbody className="[&_tr:last-child_td]:border-b-0 [&_tr]:transition-colors hover:[&_tr]:bg-muted/50">
        {children}
      </tbody>
    );
  },
  ul({ children }) {
    return <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-brand">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:font-medium marker:text-brand">{children}</ol>;
  },
  blockquote({ children }) {
    return <MarkdownBlockquote className="my-4">{children}</MarkdownBlockquote>;
  },
  hr() {
    return <hr className="my-8 border-none h-px bg-gradient-to-r from-transparent via-border to-transparent" />;
  },
};

export function DocsMarkdown({ content }: { content: string }): React.ReactElement {
  return (
    <div className="max-w-none text-base leading-7 text-foreground/90 [&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1.5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-3 [&_p]:text-pretty [&_li]:text-pretty [&_h1]:scroll-mt-16 [&_h2]:scroll-mt-16 [&_h3]:scroll-mt-16 [&_.task-list-item]:list-none [&_input[type=checkbox]]:accent-brand-500 [&_.footnotes]:mt-8 [&_.footnotes]:text-sm [&_.footnotes]:text-muted-foreground [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto [&_.katex-display]:py-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCodeFilename]}
        rehypePlugins={[
          rehypeHighlight,
          rehypeKatex,
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "append",
              properties: {
                className: ["heading-anchor"],
                ariaHidden: true,
                tabIndex: -1,
              },
              content: { type: "text", value: "#" },
            },
          ],
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./code-block";

/** mermaid is ~500 KB gzipped — load it only when a diagram actually shows up. */
let loader: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  loader ??= import("mermaid").then((m) => m.default);
  return loader;
}

let renderSeq = 0;

/**
 * Renders a ```mermaid fence as an SVG diagram. Lazy-loads mermaid on first
 * use, follows the app's dark class, and falls back to a plain CodeBlock
 * when the source fails to parse (e.g. a truncated stream).
 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const mermaid = await loadMermaid();
      const dark = document.documentElement.classList.contains("dark");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
      });
      try {
        const { svg } = await mermaid.render(`mmd-${renderSeq++}`, code);
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    render();

    // Re-render when the app theme flips (next-themes toggles .dark on <html>).
    const observer = new MutationObserver(() => render());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [code]);

  if (failed) {
    return <CodeBlock language="mermaid" code={code} />;
  }

  return (
    <div className="code-block my-3 overflow-hidden rounded-xl border border-border bg-muted/20">
      {svg === null ? (
        <div className="h-24 animate-pulse bg-muted/40" />
      ) : (
        <div
          className="flex justify-center overflow-x-auto p-4 [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}

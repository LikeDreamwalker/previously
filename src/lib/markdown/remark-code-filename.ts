import { visit } from "unist-util-visit";
import type { Node } from "unist";

type CodeNode = Node & { lang?: string | null; meta?: string | null };

/**
 * Splits the ```` ```lang:path/file.ts ```` convention into a clean `lang`
 * (so rehype-highlight still recognizes it) plus a `meta` carrying the
 * filename. A fence already using a space (```ts file.ts) is untouched —
 * mdast puts that in `meta` natively.
 */
export function remarkCodeFilename() {
  return (tree: Node) => {
    visit(tree, "code", (node: CodeNode) => {
      if (node.lang && node.lang.includes(":")) {
        const colon = node.lang.indexOf(":");
        const filename = node.lang.slice(colon + 1);
        node.lang = node.lang.slice(0, colon);
        node.meta = [filename, node.meta].filter(Boolean).join(" ");
      }
    });
  };
}

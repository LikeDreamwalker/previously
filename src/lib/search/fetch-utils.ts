/**
 * Pure helpers for the webFetch tool — no I/O, deterministic, unit-tested.
 * Kept out of tool-executors.ts so tests can import them without pulling the
 * workflow step runtime.
 */

/** Reject hostnames that resolve to local/private network space (SSRF guard). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  // IPv4 literals in the private/reserved ranges.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b, c] = ipv4.slice(1).map((n) => parseInt(n, 10));
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

/**
 * Crude HTML → plain-text extraction. Strips script/style contents, replaces
 * block breaks with newlines, removes remaining tags, decodes a few common
 * entities, and collapses whitespace. Deliberately dependency-free and
 * loss-tolerant — the main agent wants readable prose, not exact fidelity.
 */
export function extractText(html: string): string {
  const withoutScripts = html.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    " ",
  );
  const withoutStyles = withoutScripts.replace(
    /<style\b[^>]*>[\s\S]*?<\/style>/gi,
    " ",
  );
  const withoutNoscript = withoutStyles.replace(
    /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
    " ",
  );
  const withBreaks = withoutNoscript
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return withBreaks
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

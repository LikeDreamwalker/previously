/**
 * Pure helpers for the webFetch tool — no I/O, deterministic, unit-tested.
 * Kept out of tool-executors.ts so tests can import them without pulling the
 * workflow step runtime.
 */
import { convertHtmlToMarkdown } from "markitdown-html";

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

  // IPv6 literals (URL hostnames keep the brackets — strip them).
  const ipv6 = host.startsWith("[") ? host.slice(1, -1) : host;
  if (ipv6.includes(":")) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) — judge by the embedded IPv4.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ipv6);
    if (mapped) return isPrivateHost(mapped[1]);
    const first = ipv6.split(":")[0];
    const firstWord = parseInt(first || "0", 16);
    return (
      ipv6 === "::" || // unspecified
      ipv6 === "::1" || // loopback
      (firstWord & 0xfe00) === 0xfc00 || // ULA fc00::/7
      (firstWord & 0xffc0) === 0xfe80 // link-local fe80::/10
    );
  }

  // IPv4 literals in the private/loopback/link-local/reserved ranges.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((n) => parseInt(n, 10));
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) || // link-local incl. cloud metadata
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
      a >= 224 // multicast 224/4 + reserved 240/4
    );
  }
  return false;
}

/**
 * SSRF-safe fetch: follows redirects MANUALLY, re-validating every hop's URL
 * through isPrivateHost before requesting it. A plain
 * `fetch(url, { redirect: "follow" })` lets an allowed public URL 302 into
 * http://169.254.169.254/ (cloud metadata) or any internal address; this
 * loop closes that hole. Max 5 hops, then throws. DNS resolution is not
 * available here, so hostnames that merely *resolve* to private space are
 * out of scope — IP literals are covered by isPrivateHost.
 */
export async function fetchWithGuard(
  url: string,
  init?: RequestInit,
  maxHops = 5
): Promise<Response> {
  let current = url;
  let requestInit: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; ; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new Error("Blocked fetch of local or private network address");
    }

    const res = await fetch(current, requestInit);

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) {
      return res;
    }
    if (hop >= maxHops) {
      throw new Error(`Too many redirects (>${maxHops})`);
    }

    current = new URL(location, current).toString();

    // Per fetch spec, 303 (and 301/302 for non-GET/HEAD) downgrade to GET.
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) &&
        requestInit.method !== undefined &&
        !/^(GET|HEAD)$/i.test(requestInit.method))
    ) {
      const { method: _m, body: _b, ...rest } = requestInit;
      requestInit = rest;
    }
  }
}

/** Hard cap on a fetched page's body: 2 MB. The 30s fetch timeout bounds
 *  TIME, not SIZE — a fast server could otherwise stream a hundred-MB page
 *  into memory and then into the sub-agent's context. Two layers of defense:
 *  a truthful content-length over the cap marks the body truncated up front,
 *  and the stream read itself stops at the cap, so a server that under-
 *  reports (or omits) the length still gets cut off. */
export const FETCH_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read a response body as text, capped at `maxBytes`. Returns the decoded
 * text plus a `truncated` flag so the caller can tell the model the page was
 * cut. A cut mid multibyte character decodes to U+FFFD at the tail —
 * acceptable, since the truncation note already marks the boundary.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number = FETCH_BODY_MAX_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "");
  let truncated = Number.isFinite(declared) && declared > maxBytes;

  if (!res.body) {
    // No stream (edge runtimes, test doubles) — full read, then truncate the
    // encoded bytes after the fact.
    const bytes = new TextEncoder().encode(await res.text());
    if (bytes.byteLength > maxBytes) truncated = true;
    return {
      text: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
      truncated,
    };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop the download when we cut early — the rest of the body is unwanted.
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * HTML → Markdown text extraction. markitdown-html (a TypeScript port of
 * Microsoft MarkItDown's HTML converter — pure JS on htmlparser2, no DOM or
 * native binaries) does the conversion, preserving headings, lists, links and
 * table structure. Boilerplate containers (nav/header/footer/aside/form) are
 * pre-stripped so menus and footers don't leak into the text; the converter
 * itself drops script/style contents. Non-breaking spaces are normalized to
 * plain spaces — the converter keeps the decoded U+00A0, which reads and
 * searches worse than a regular space.
 *
 * Known tradeoff: the pre-strip regex cannot tell a site-chrome <header>/
 * <footer> from an ARTICLE-level one, so a post's title/byline/date wrapped
 * in <article><header>…</header> is sacrificed too. Accepted: boilerplate
 * removal matters more for readability, and article headings outside those
 * containers survive.
 *
 * When conversion throws or yields empty output, the old regex stripper below
 * runs as a loss-tolerant fallback — the main agent wants readable prose, not
 * exact fidelity.
 */
export function extractText(html: string): string {
  try {
    const withoutBoilerplate = html.replace(
      /<(script|style|noscript|nav|header|footer|aside|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
    const markdown = convertHtmlToMarkdown(withoutBoilerplate).replace(
      /\u00a0/g,
      " ",
    );
    if (markdown.trim().length > 0) return markdown;
  } catch {
    // Fall through to the regex fallback.
  }
  return extractTextFallback(html);
}

/**
 * Crude HTML → plain-text extraction. Strips script/style contents, replaces
 * block breaks with newlines, removes remaining tags, decodes a few common
 * entities, and collapses whitespace. Deliberately dependency-free and
 * loss-tolerant — kept as the internal fallback for extractText.
 */
function extractTextFallback(html: string): string {
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

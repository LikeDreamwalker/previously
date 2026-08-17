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

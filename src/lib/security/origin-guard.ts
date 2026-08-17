/**
 * Lightweight "block external callers" guard for the mutation endpoints.
 *
 * This is a single-user, privately-deployed product — there is deliberately
 * no login system. The goal is only to stop drive-by traffic (port scanners,
 * random bots, cross-site posts from other web pages) from invoking the
 * expensive/destructive POST endpoints, without adding any friction to the
 * owner's own browser or their scripts/cron jobs.
 *
 * Policy (POST only — GET stream-replay endpoints and OPTIONS preflights
 * stay open):
 *  1. An `Origin` header whose host matches the request's own host
 *     (`X-Forwarded-Host` first, then `Host`) is a same-origin browser
 *     fetch → allow.
 *  2. No `Origin` but `Sec-Fetch-Site: same-origin` / `same-site` → allow
 *     (browser navigation/same-site fetch without an Origin header).
 *  3. Otherwise the caller looks like curl/scripts/cron: require the
 *     `x-access-key` header to equal `process.env.ACCESS_SECRET` — but ONLY
 *     when that env var is set. When `ACCESS_SECRET` is not set, everything
 *     is allowed: the private-deployment default stays frictionless, and
 *     operators opt into the key check by setting the variable.
 */
export function guardRequest(req: Request): Response | null {
  // The guard protects mutation endpoints; preflights and reads stay open.
  if (req.method !== "POST") {
    return null;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const requestHost = (
        req.headers.get("x-forwarded-host") ??
        req.headers.get("host") ??
        ""
      )
        .split(",")[0]
        .trim()
        .toLowerCase();
      if (requestHost && originHost === requestHost) {
        return null;
      }
    } catch {
      // Malformed Origin — fall through to the access-key check.
    }
  } else {
    const secFetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
    if (secFetchSite === "same-origin" || secFetchSite === "same-site") {
      return null;
    }
  }

  // No verifiable same-origin signal (curl, scripts, cron, cross-site posts).
  // Opt-in key check: without ACCESS_SECRET the private deployment stays open.
  const secret = process.env.ACCESS_SECRET;
  if (!secret) {
    return null;
  }
  if (req.headers.get("x-access-key") === secret) {
    return null;
  }

  return Response.json({ error: "Forbidden" }, { status: 403 });
}

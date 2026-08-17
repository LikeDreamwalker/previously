import { describe, it, expect, beforeEach, vi } from "vitest";
import { fetchWithGuard } from "@/lib/search/fetch-utils";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("fetchWithGuard", () => {
  it("returns the response for a direct public fetch", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await fetchWithGuard("https://example.com/page");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Redirects must be handled manually so every hop is re-validated.
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("blocks an initial private URL without calling fetch", async () => {
    await expect(fetchWithGuard("http://169.254.169.254/latest/meta-data"))
      .rejects.toThrow(/private/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect to the cloud metadata endpoint (SSRF)", async () => {
    mockFetch.mockResolvedValueOnce(redirectTo("http://169.254.169.254/"));
    await expect(fetchWithGuard("https://example.com/short-link"))
      .rejects.toThrow(/private/i);
    // The redirect target is never actually requested.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects to IPv6 loopback / ULA / link-local", async () => {
    for (const target of ["http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/"]) {
      mockFetch.mockResolvedValueOnce(redirectTo(target));
      await expect(fetchWithGuard("https://example.com/x")).rejects.toThrow(/private/i);
    }
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("follows redirects to public URLs and resolves relative locations", async () => {
    mockFetch
      .mockResolvedValueOnce(redirectTo("/next"))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    const res = await fetchWithGuard("https://example.com/start");
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[1][0]).toBe("https://example.com/next");
  });

  it("gives up after 5 redirect hops", async () => {
    mockFetch.mockResolvedValue(redirectTo("https://example.com/loop"));
    await expect(fetchWithGuard("https://example.com/loop"))
      .rejects.toThrow(/redirect/i);
    expect(mockFetch).toHaveBeenCalledTimes(6); // initial + 5 hops
  });
});

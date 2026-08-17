import { describe, it, expect, afterEach, vi } from "vitest";
import { guardRequest } from "@/lib/security/origin-guard";

const URL = "http://localhost:3000/api/chat";

function postReq(headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("guardRequest", () => {
  it("allows non-POST methods unconditionally (GET replay, OPTIONS preflight)", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    expect(guardRequest(new Request(URL, { method: "GET" }))).toBeNull();
    expect(guardRequest(new Request(URL, { method: "OPTIONS" }))).toBeNull();
  });

  it("allows same-origin browser fetches (Origin host matches Host)", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const req = postReq({ origin: "http://localhost:3000", host: "localhost:3000" });
    expect(guardRequest(req)).toBeNull();
  });

  it("allows same-origin fetches matched via X-Forwarded-Host", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const req = postReq({
      origin: "https://app.example.com",
      "x-forwarded-host": "app.example.com",
      host: "internal:3000",
    });
    expect(guardRequest(req)).toBeNull();
  });

  it("allows Sec-Fetch-Site same-origin / same-site when Origin is absent", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    expect(guardRequest(postReq({ "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(guardRequest(postReq({ "sec-fetch-site": "same-site" }))).toBeNull();
  });

  it("rejects cross-site posts when ACCESS_SECRET is set", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const req = postReq({ "sec-fetch-site": "cross-site" });
    const res = guardRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects Origin/Host mismatch when ACCESS_SECRET is set", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const req = postReq({ origin: "https://evil.example", host: "localhost:3000" });
    expect(guardRequest(req)!.status).toBe(403);
  });

  it("rejects origin-less requests (curl/scripts) when ACCESS_SECRET is set", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    expect(guardRequest(postReq())!.status).toBe(403);
  });

  it("allows origin-less requests carrying the correct x-access-key", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    expect(guardRequest(postReq({ "x-access-key": "s3cret" }))).toBeNull();
  });

  it("rejects a wrong x-access-key", () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    expect(guardRequest(postReq({ "x-access-key": "wrong" }))!.status).toBe(403);
  });

  it("allows everything when ACCESS_SECRET is not set (frictionless default)", () => {
    vi.stubEnv("ACCESS_SECRET", "");
    expect(guardRequest(postReq())).toBeNull();
    expect(
      guardRequest(postReq({ origin: "https://evil.example", host: "localhost:3000" }))
    ).toBeNull();
  });
});

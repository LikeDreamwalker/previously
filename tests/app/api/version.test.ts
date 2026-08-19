import { describe, it, expect, afterEach } from "vitest";
import { GET } from "@/app/api/version/route";
import { APP_VERSION } from "@/lib/version/constants";

const SAVED_MODE = process.env.PREVIOUSLY_MODE;

afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.PREVIOUSLY_MODE;
  else process.env.PREVIOUSLY_MODE = SAVED_MODE;
});

describe("GET /api/version", () => {
  it("returns the app version and cloud mode by default", async () => {
    delete process.env.PREVIOUSLY_MODE;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: APP_VERSION, mode: "cloud" });
  });

  it("reports client mode when PREVIOUSLY_MODE=client", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    const res = await GET();
    const body = await res.json();
    expect(body.version).toBe(APP_VERSION);
    expect(body.mode).toBe("client");
  });
});

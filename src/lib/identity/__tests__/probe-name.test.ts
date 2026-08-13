import { beforeAll, it } from "vitest";

beforeAll(() => {
  // STORAGE=local is the explicit override (resolveDataSource gives it top
  // priority), so the probe runs against the real local memory, not the
  // auto-detected test env. NODE_ENV is read-only in the type and unneeded.
  process.env.STORAGE = "local";
});

it("probe: getUserName resolution + timing", async () => {
  const { getUserName } = await import("@/lib/identity");
  const t0 = Date.now();
  const name = await getUserName().catch((e) => `ERR:${e?.message}`);
  console.log("NAME:", JSON.stringify(name), "in", Date.now() - t0, "ms");
});

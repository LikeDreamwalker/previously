/** Rev 11 probe — verify deal-in animation does NOT replay on scroll-mounted rows.
 *  Boots its own isolated dev server (port 3100) so it never needs real data. */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const E2E_PORT = 3000;
const BASE = `http://localhost:${E2E_PORT}`;
const PREVIOUSLY_HOME = path.join(os.tmpdir(), "previously-e2e", "home");
const MEMORY_ROOT = path.join(os.tmpdir(), "previously-e2e", "memory");
const EPISODIC_ROOT = path.join(MEMORY_ROOT, "episodic");

function sliceIdFromStart(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function serializeSlice(slice) {
  const fm = [
    `slice_id: ${JSON.stringify(slice.id)}`,
    `focus: ${JSON.stringify(slice.focus ?? "")}`,
    `status: ${slice.status ?? "closed"}`,
    `start: ${JSON.stringify(slice.start)}`,
    `end: ${JSON.stringify(slice.end)}`,
    `timezone: "UTC"`,
    `summary: ${JSON.stringify(slice.summary ?? "")}`,
    `open_loops: []`,
    `decisions: []`,
    `tags: ${JSON.stringify(slice.tags ?? [])}`,
    `related_slices: []`,
    `loops: []`,
    `strands: ${JSON.stringify(slice.strands ?? [])}`,
    `closed_by: ${JSON.stringify(slice.closedBy ?? "idle_gap")}`,
  ];
  const body = slice.turns
    .map(
      (t, i) =>
        `## Turn ${t.turnId ?? `ft${i}`} — ${t.at} (${t.role})\n\n${t.content}`,
    )
    .join("\n\n");
  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

async function seedSlices() {
  const DAY = 24 * 3600_000;
  const base = Date.UTC(2026, 1, 1, 9, 0, 0);
  const slices = [];
  for (let i = 0; i < 12; i++) {
    const startIso = new Date(base + i * DAY).toISOString();
    const endIso = new Date(base + i * DAY + 20 * 60_000).toISOString();
    const tag = `S${String(i).padStart(2, "0")}`;
    const id = sliceIdFromStart(startIso);
    slices.push({
      id,
      start: startIso,
      end: endIso,
      status: "closed",
      focus: `Focus of ${tag}`,
      summary: `Summary of ${tag}`,
      tags: [],
      strands: [],
      closedBy: "idle_gap",
      turns: [
        { role: "user", content: `TURN ${tag} user question`, at: startIso },
        {
          role: "agent",
          content: `TURN ${tag} agent answer`,
          at: new Date(base + i * DAY + 60_000).toISOString(),
        },
      ],
    });
  }
  slices.sort((a, b) => a.id.localeCompare(b.id));

  for (const slice of slices) {
    const [y, m, d, hm] = slice.id.split("-");
    const dir = path.join(EPISODIC_ROOT, "slices", y, m, d, hm, "timeline");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "core.md"), serializeSlice(slice), "utf8");
  }

  const catalog = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: slices.length,
    needs_marking: 0,
    slices: slices.map((s) => ({
      id: s.id,
      date: s.id.slice(0, 10),
      start: s.start,
      end: s.end,
      turn_count: s.turns.length,
      status: s.status,
      focus: s.focus,
      summary: s.summary,
      tags: s.tags,
      open_loops: [],
      decisions: [],
      strands: s.strands,
      needs_marking: false,
      closed_by: s.closedBy,
    })),
  };
  const timelineDir = path.join(EPISODIC_ROOT, "timeline");
  await mkdir(timelineDir, { recursive: true });
  await writeFile(
    path.join(timelineDir, "index.json"),
    JSON.stringify(catalog, null, 2),
    "utf8",
  );
}

async function prepareEnv() {
  for (const dir of [PREVIOUSLY_HOME, MEMORY_ROOT]) {
    if (!dir.includes("previously-e2e")) {
      throw new Error(`refusing unexpected path: ${dir}`);
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
  await mkdir(path.join(MEMORY_ROOT, "user"), { recursive: true });
  await writeFile(
    path.join(MEMORY_ROOT, "user", "config.json"),
    JSON.stringify({ model: { provider: "bridge/claude" } }, null, 2) + "\n",
    "utf8",
  );
}

function waitForPort(port, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = async () => {
      try {
        const res = await fetch(`http://localhost:${port}/zh/timeline`);
        if (res.status === 200) {
          resolve();
          return;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`server on port ${port} did not become ready`));
        return;
      }
      setTimeout(tryConnect, 400);
    };
    tryConnect();
  });
}

async function killExistingDevServer() {
  // Next.js refuses to start a second dev server for the same project dir,
  // so terminate any listener on port 3000 before booting our isolated one.
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("netstat -ano", { encoding: "utf8" });
    const pid = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /[:.]3000\b/.test(l) && l.includes("LISTENING"))
      .map((l) => l.split(/\s+/).pop())
      .find((p) => p && /^\d+$/.test(p));
    if (pid) {
      console.log(`Killing existing dev server PID ${pid}`);
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch {
    // ignore
  }
}

function startServer() {
  const proc = spawn(
    "node",
    [
      path.join(process.cwd(), "node_modules/next/dist/bin/next"),
      "dev",
      "--turbopack",
      "--port",
      String(E2E_PORT),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PREVIOUSLY_MODE: "client",
        PREVIOUSLY_BRAIN: "bridge",
        PREVIOUSLY_HOME,
        MEMORY_ROOT,
        STORAGE: "local",
      },
      stdio: "pipe",
      detached: true,
    },
  );
  proc.stdout.on("data", (d) => {
    const line = d.toString();
    if (line.includes("error") || line.includes("Error")) console.log("SERVER:", line.slice(0, 200));
  });
  proc.stderr.on("data", (d) => console.log("SERVER ERR:", d.toString().slice(0, 200)));
  return proc;
}

async function zoomStep(page, dir) {
  await page.evaluate((deltaY) => {
    const el =
      document.querySelector("[data-card-field]") ??
      document.querySelector("[data-virtuoso-scroller]") ??
      document.body;
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, dir === "in" ? -240 : 240);
}

async function cardLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".tl-card-in")].map(
      (c) => c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "",
    ),
  );
}

async function main() {
  await prepareEnv();
  await seedSlices();

  // generate-identity is part of the predev hook; run it explicitly so the
  // dev server finds its bundled identity.
  const gen = spawn("node", ["scripts/generate-identity.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PREVIOUSLY_HOME, MEMORY_ROOT, STORAGE: "local" },
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    gen.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`generate-identity exited ${code}`)),
    );
  });

  await killExistingDevServer();

  const server = startServer();
  let serverExited = false;
  server.on("exit", (code) => {
    serverExited = true;
    if (code !== 0 && code !== null) console.log(`server exited ${code}`);
  });

  try {
    await waitForPort(E2E_PORT, 120_000);
  } catch (e) {
    if (!serverExited) server.kill("SIGTERM");
    throw e;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
    colorScheme: "dark",
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`CONSOLE[${m.type()}]:`, m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 500)));

  await page.goto(`${BASE}/zh/timeline`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);

  let labels = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    labels = await cardLabels(page);
    if (labels.length > 0) break;
    await page.waitForTimeout(500);
  }
  if (labels.length === 0) {
    console.error("No cards rendered — aborting probe.");
    await browser.close();
    if (!serverExited) server.kill("SIGTERM");
    process.exit(1);
  }
  console.log("Initial labels:", labels.slice(0, 4));

  await page.evaluate(() => {
    window.__dealDebug = [];
  });

  // L1 -> L0 zoom in; visible rows at the transition should deal in.
  await zoomStep(page, "in");
  await page.waitForTimeout(1600);

  const transitionMounts = await page.evaluate(() => window.__dealDebug ?? []);
  const transitionDealt = transitionMounts.filter((m) => m.initialDeal === 0);
  console.log(
    `Transition-phase mounts: ${transitionMounts.length}, dealt: ${transitionDealt.length}`,
  );
  if (transitionDealt.length === 0) {
    console.error("FAIL: no visible rows played the deal-in animation after transition.");
    await browser.close();
    if (!serverExited) server.kill("SIGTERM");
    process.exit(1);
  }

  await page.evaluate(() => {
    window.__dealDebug = [];
  });

  // Aggressively scroll for several seconds to force many row mounts/unmounts.
  const field = page.locator("[data-card-field]");
  await field.hover();
  for (let burst = 0; burst < 40; burst++) {
    await page.mouse.wheel(0, burst % 2 === 0 ? 2200 : -2200);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);

  const scrollMounts = await page.evaluate(() => window.__dealDebug ?? []);
  console.log(
    `Scroll-phase mounts: ${scrollMounts.length}`,
    scrollMounts.map((m) => `${m.rowKey}=${m.initialDeal}`).join(", "),
  );

  const bad = scrollMounts.filter((m) => m.initialDeal !== 1);
  await browser.close();

  if (bad.length > 0) {
    console.error(
      "FAIL: rows mounted during scrolling with deal animation:",
      bad.map((m) => `${m.rowKey}=${m.initialDeal}`).join(", "),
    );
    if (!serverExited) server.kill("SIGTERM");
    process.exit(1);
  }

  console.log("PASS: transition rows dealt, scroll rows stayed static.");
  if (!serverExited) server.kill("SIGTERM");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Rev 11 chat serif probe — verify agent message body uses serif, user bubble stays sans.
 *  Boots its own isolated dev server (port 3000) with a seeded recent slice,
 *  then exercises both the history-turn path and the live ChatMessage path. */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

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

async function seedSlice() {
  const now = Date.now();
  const startIso = new Date(now - 4 * 60_000).toISOString();
  const agentIso = new Date(now - 2 * 60_000).toISOString();
  const endIso = new Date(now - 30_000).toISOString();
  const id = sliceIdFromStart(startIso);

  const slice = {
    id,
    start: startIso,
    end: endIso,
    status: "active",
    focus: "Serif probe",
    summary: "Probe slice for chat font check",
    tags: [],
    strands: [],
    closedBy: "idle_gap",
    turns: [
      {
        role: "user",
        content: "User question for serif probe.",
        at: startIso,
        turnId: "u1",
      },
      {
        role: "agent",
        content: "Agent reply for serif probe.",
        at: agentIso,
        turnId: "a1",
      },
    ],
  };

  const [y, m, d, hm] = id.split("-");
  const dir = path.join(EPISODIC_ROOT, "slices", y, m, d, hm, "timeline");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "core.md"), serializeSlice(slice), "utf8");

  const catalog = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: 1,
    needs_marking: 0,
    slices: [
      {
        id: slice.id,
        date: slice.id.slice(0, 10),
        start: slice.start,
        end: slice.end,
        turn_count: slice.turns.length,
        status: slice.status,
        focus: slice.focus,
        summary: slice.summary,
        tags: slice.tags,
        open_loops: [],
        decisions: [],
        strands: slice.strands,
        needs_marking: false,
        closed_by: slice.closedBy,
      },
    ],
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
        const res = await fetch(`http://localhost:${port}/en`);
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
    if (line.includes("error") || line.includes("Error"))
      console.log("SERVER:", line.slice(0, 200));
  });
  proc.stderr.on("data", (d) =>
    console.log("SERVER ERR:", d.toString().slice(0, 200)),
  );
  return proc;
}

async function fakeChatResponse(text) {
  const stream = createUIMessageStream({
    execute({ writer }) {
      writer.write({ type: "start", messageId: "live-agent-msg" });
      writer.write({ type: "text-start", id: "live-text-1" });
      writer.write({ type: "text-delta", id: "live-text-1", delta: text });
      writer.write({ type: "text-end", id: "live-text-1" });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { "x-workflow-run-id": "probe-run-1" },
  });
}

async function readComputedFonts(page, agentText, userText) {
  return page.evaluate(
    ({ expectedAgentText, expectedUserText }) => {
      const agentEls = [
        ...document.querySelectorAll(
          '[data-slot="message"][data-align="start"] .typeset p',
        ),
      ];
      const userEls = [
        ...document.querySelectorAll(
          '[data-slot="message"][data-align="end"] [data-slot="bubble-content"]',
        ),
      ];
      const agentEl = agentEls.find((el) =>
        el.textContent?.includes(expectedAgentText),
      );
      const userEl = userEls.find((el) =>
        el.textContent?.includes(expectedUserText),
      );
      return {
        agentFont: agentEl ? window.getComputedStyle(agentEl).fontFamily : null,
        userFont: userEl ? window.getComputedStyle(userEl).fontFamily : null,
        agentText: agentEl?.textContent?.slice(0, 80) ?? null,
        userText: userEl?.textContent?.slice(0, 80) ?? null,
        agentCount: agentEls.length,
        userCount: userEls.length,
      };
    },
    { expectedAgentText: agentText, expectedUserText: userText },
  );
}

function assertFont(label, result, expectSerif) {
  const font = expectSerif ? result.agentFont : result.userFont;
  const hasSerif = font?.includes("Source Serif");
  const hasRaleway = font?.includes("Raleway");
  if (expectSerif) {
    if (!hasSerif) {
      console.error(`FAIL: ${label} agent body is not serif — ${font}`);
      return false;
    }
    console.log(`PASS: ${label} agent body is serif — ${font}`);
  } else {
    if (!hasRaleway || hasSerif) {
      console.error(
        `FAIL: ${label} user bubble is not Raleway / is serif — ${font}`,
      );
      return false;
    }
    console.log(`PASS: ${label} user bubble is sans (Raleway) — ${font}`);
  }
  return true;
}

async function main() {
  await prepareEnv();
  await seedSlice();

  const gen = spawn("node", ["scripts/generate-identity.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PREVIOUSLY_HOME, MEMORY_ROOT, STORAGE: "local" },
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    gen.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`generate-identity exited ${code}`)),
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
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`CONSOLE[${m.type()}]:`, m.text().slice(0, 300));
  });
  page.on("pageerror", (e) =>
    console.log("PAGEERROR:", e.message.slice(0, 500)),
  );

  await page.goto(`${BASE}/en`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2000);

  // Wait for the message stream to render.
  try {
    await page.waitForSelector('[data-slot="message"]', { timeout: 30_000 });
  } catch (e) {
    const html = await page.content();
    console.error("Stream did not render. Page snippet:", html.slice(0, 1200));
    await page.screenshot({ path: "shots/rev11-chat-serif-debug.png" });
    throw e;
  }

  // ── 1. History-turn path (resume from seeded slice) ──────────────────────
  const historyResult = await readComputedFonts(
    page,
    "Agent reply for serif probe",
    "User question for serif probe",
  );
  console.log(
    "History path computed fonts:",
    JSON.stringify(historyResult, null, 2),
  );

  let allPass = true;
  allPass = assertFont("history", historyResult, true) && allPass;
  allPass = assertFont("history", historyResult, false) && allPass;

  // ── 2. Live ChatMessage path (mock the chat API) ─────────────────────────
  await page.route(`${BASE}/api/chat`, async (route) => {
    const response = await fakeChatResponse(
      "Live agent reply for serif probe.",
    );
    const body = await response.text();
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    });
  });

  const input = page.locator("textarea").first();
  await input.fill("Live user question for serif probe.");
  await input.press("Enter");

  // Wait for the mock agent reply to render in the live stream.
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll('[data-slot="message"][data-align="start"] .typeset p')].some((el) =>
        el.textContent?.includes("Live agent reply for serif probe."),
      );
    },
    { timeout: 30_000 },
  );

  const liveResult = await readComputedFonts(
    page,
    "Live agent reply for serif probe",
    "Live user question for serif probe",
  );
  console.log(
    "Live path computed fonts:",
    JSON.stringify(liveResult, null, 2),
  );

  allPass = assertFont("live", liveResult, true) && allPass;
  allPass = assertFont("live", liveResult, false) && allPass;

  await browser.close();

  if (!serverExited) server.kill("SIGTERM");

  if (!allPass) process.exit(1);
  console.log("PASS: both history and live paths use the correct fonts.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

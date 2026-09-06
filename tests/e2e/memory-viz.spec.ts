import { test, expect, type Page } from "@playwright/test";
import {
  clearEpisodic,
  makeSlice,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

/**
 * v0.10 memory-viz e2e (design doc §9): the unified message stream's
 * scroll-up paging + seams, the arrival resume/briefing gate (Rev 2: the
 * briefing seats as a stream-tail card), the scroll-transient left time rail
 * (Rev 2, §1.3), the card-style left-drag mode gesture (Rev 2, §5.2/§6.1),
 * the search palette's jump-to-slice, and the /timeline route's two entry
 * forms (Rev 2 hint copy + the NOW convergence point's DOM existence).
 *
 * All specs seed slice files + the timeline catalog straight into the
 * isolated MEMORY_ROOT (see memory-fixture.ts) — no chat turn ever runs, so
 * the bridge-mode dev server never needs a real agent CLI.
 *
 * Serialized within the file: every test rewrites the shared MEMORY_ROOT the
 * (single) dev server reads. The webServer env pins slicing.idleGapMinutes
 * to its 30-minute default, so "fresh" slices are seeded <10 min old and
 * "historical" ones in February 2026 (now ≈ September 2026).
 */

const DAY = 24 * 3600_000;

/** Sentinel turn text — rendered verbatim by HistoryTurn. */
function sentinel(slice: FixtureSlice, role: "user" | "agent"): string {
  return slice.turns.find((t) => t.role === role)!.content;
}

/**
 * Twelve historical slices, one per day from 2026-02-01, with a checkpoint
 * chain in the middle: S01 closed by time_cap, S02 continues it (capacity
 * close) — everything else closes on idle_gap (a genuine boundary). S07
 * carries the unique search keyword "zebra". All older than any idle gap, so
 * arrival is always the briefing unless a fresh slice is added.
 */
function datasetA(): FixtureSlice[] {
  const base = Date.UTC(2026, 1, 1, 9, 0, 0);
  const slices: FixtureSlice[] = [];
  for (let i = 0; i < 12; i++) {
    slices.push(
      makeSlice(new Date(base + i * DAY).toISOString(), {
        tag: `S${String(i).padStart(2, "0")}`,
      }),
    );
  }
  slices[1].closedBy = "time_cap";
  slices[2].continuesFrom = slices[1].id;
  slices[2].closedBy = "capacity";
  slices[7].focus = "Zebra quantum retrospective";
  slices[7].tags = ["zebra"];
  return slices;
}

/** The still-alive slice for the resume test: last turn <10 min ago. */
function freshSlice(): FixtureSlice {
  const startIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const slice = makeSlice(startIso, { tag: "FRESH" });
  slice.status = "active";
  delete slice.end;
  delete slice.closedBy;
  return slice;
}

/** Detect WebGL the same way TimelineScene does, to pick the assertion branch. */
function probeWebGL(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch {
      return false;
    }
  });
}

test.describe("Memory viz (v0.10)", () => {
  test.describe.configure({ mode: "serial" });

  test.afterEach(async () => {
    await clearEpisodic();
  });

  test.describe("unified message stream", () => {
    test("scroll-up pages older slices across seams without losing the position", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      // Engage the stream by jumping to S09 (deep inside the initial
      // 10-slice page — deliberately far from the loaded window's top so the
      // landing itself does not fire startReached) — the time-travel clock
      // plays (~2.2s), then the stream lands on S09's seam.
      await page.goto(`/en?at=${slices[9].id}`);
      await expect(
        page.getByText(sentinel(slices[9], "user")),
      ).toBeVisible();
      // The sentinel can render inside Virtuoso's overscan BEFORE the
      // deep-link jump actually scrolls (the travel clock rolls ~3.4s first).
      // Writing scrollTop=0 ahead of the jump would race its landing — gate on
      // the jump having landed (it leaves the stream mid-list, scrollTop > 0).
      const scroller = page.locator('[data-testid="virtuoso-scroller"]');
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      // The initial page is the newest 10 slices: S00/S01 are NOT loaded yet.
      await expect(page.getByText(sentinel(slices[0], "user"))).toHaveCount(0);

      // Scroll to the very top — startReached pages the two older slices in.
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      // Virtuoso's prepend pattern holds the viewport: the scroller's offset
      // shifts down by the added height instead of yanking the view to the
      // new top (design §9's "prepend 不跳动").
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);

      // Now actually view the new top: the oldest slice's turns render, and
      // both seam kinds show their localized labels.
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(
        page.getByText(sentinel(slices[0], "user")),
      ).toBeVisible();
      // Boundary seams (idle_gap): a strong divider with a date heading.
      await expect(
        page.getByText(/New conversation/).first(),
      ).toBeVisible();
      // Checkpoint seams (time_cap/capacity chain S01→S02→S03): a whisper.
      await expect(
        page.getByText(/Auto-archived/).first(),
      ).toBeVisible();
    });
  });

  test.describe("arrival gate", () => {
    test("resumes the still-alive slice with a banner instead of the briefing", async ({
      page,
    }) => {
      const old = makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), {
        tag: "OLD",
      });
      const fresh = freshSlice();
      await seedSlices([old, fresh]);

      await page.goto("/en");
      // chat.resume.banner — the restored turns sit directly under it.
      await expect(
        page.getByText(/Continuing the conversation from/),
      ).toBeVisible();
      await expect(page.getByText(sentinel(fresh, "user"))).toBeVisible();
      await expect(page.getByText(sentinel(fresh, "agent"))).toBeVisible();
      // The empty briefing is the OTHER branch — it must not render here.
      await expect(
        page.getByText("PREVIOUSLY ON", { exact: true }),
      ).toHaveCount(0);
    });

    test("seats the briefing as a stream-tail card with history above (Rev 2)", async ({
      page,
    }) => {
      const slices = [
        makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), {
          tag: "OLD1",
        }),
        makeSlice(new Date(Date.UTC(2026, 1, 2, 9)).toISOString(), {
          tag: "OLD2",
        }),
      ];
      await seedSlices(slices);

      await page.goto("/en");
      // §1.2 Rev 2: the stream is ALWAYS the view — the EmptyBriefing content
      // rides the stream's tail as a card (not a standalone briefing page).
      await expect(
        page.getByText("PREVIOUSLY ON", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("textarea")).toBeVisible();
      await expect(
        page.getByText(/Continuing the conversation from/),
      ).toHaveCount(0);

      // Scrolling up from the briefing card walks straight into the
      // historical slices — no separate history view.
      const scroller = page.locator('[data-testid="virtuoso-scroller"]');
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(page.getByText(sentinel(slices[0], "user"))).toBeVisible();
      await expect(page.getByText(sentinel(slices[0], "agent"))).toBeVisible();
    });
  });

  test.describe("left time rail (Rev 2, §1.3)", () => {
    test("desktop scroll fades the rail in with turn-granular nodes, then out", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en");
      // Stream settled at its tail (briefing mode) before scrolling.
      await expect(page.getByText(sentinel(slices[11], "user"))).toBeVisible();

      const rail = page.locator(
        'div[aria-label="Timeline of the messages on screen"]',
      );
      // Idle: the transient rail is faded out (still mounted, aria-hidden).
      await expect(rail).toHaveAttribute("aria-hidden", "true");

      // Scroll — the rail fades in and every visible turn anchors a node
      // carrying a rolling-digit HH:MM timestamp.
      const scroller = page.locator('[data-testid="virtuoso-scroller"]');
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight / 2;
      });
      await expect(rail).toHaveAttribute("aria-hidden", "false");
      await expect(rail.locator("span.font-mono").first()).toBeVisible();

      // ~1s after the scroll stops the rail fades out again (§1.3).
      await expect(rail).toHaveAttribute("aria-hidden", "true", {
        timeout: 5_000,
      });
    });
  });

  test.describe("card-style mode gesture (Rev 2, §5.2/§6.1)", () => {
    // Rev 6 (2026-09-07): the swipe mode switch is unwired — ModeSwitchGesture
    // no longer wraps the content region. The spec stays for restoration once
    // the gesture returns in its redesigned form.
    test.skip("a committed left drag on the content card routes to /timeline", async ({
      page,
    }) => {
      // The timeline overlay compiles the three.js chunk on first hit in dev.
      test.slow();
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en");
      // Hydration gate before the synthetic drag: the stream's slice content
      // only appears after a CLIENT-side fetch (SSR renders no turns), so a
      // visible sentinel proves the chat subtree — and with it the gesture's
      // pointerdown handler — is hydrated. (The header badge alone is not
      // enough: client subtrees hydrate independently and the header can win
      // the race.)
      await expect(page.getByText(sentinel(slices[11], "user"))).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();

      // Drag start on a mid-stream history turn — plain text, NOT inside a
      // button/a/input (the gesture ignores those). Virtuoso's bottom
      // anchoring can leave the tail briefing card a few px below the fold
      // (a boundingBox there hits <html> and the drag never starts), so
      // anchor on an in-stream turn and verify it is inside the viewport.
      const anchor = page.getByText(sentinel(slices[10], "user"));
      const viewport = page.viewportSize()!;
      await expect
        .poll(
          async () => {
            await anchor.scrollIntoViewIfNeeded();
            const b = await anchor.boundingBox();
            return (
              b !== null && b.y >= 48 && b.y + b.height <= viewport.height - 4
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // 160px left in 20px steps: the direction lock claims the horizontal
      // axis, and 160 > the 120px commit threshold (lib/chat/mode-gesture.ts).
      // The stream can re-lay-out under Virtuoso, so a measured anchor can go
      // stale mid-drag — retry the whole gesture with a fresh box.
      const card = page.getByTestId("mode-switch-card");
      for (let attempt = 0; attempt < 3; attempt++) {
        const b = (await anchor.boundingBox())!;
        const sx = b.x + b.width / 2;
        const sy = b.y + b.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let dx = 20; dx <= 160; dx += 20) {
          await page.mouse.move(sx - dx, sy);
        }
        // motion's pan session updates on animation frames — web-first poll
        // until the drag position is registered before releasing (no sleeps).
        const moved = await expect
          .poll(() => card.evaluate((el) => el.style.transform), {
            timeout: 3_000,
          })
          .toContain("translateX(-160px)")
          .then(() => true)
          .catch(() => false);
        await page.mouse.up();
        if (moved) break;
      }

      // Committed → routed navigation carrying the viewport slice as ?at=.
      await expect(page).toHaveURL(/\/en\/timeline/);
    });
  });

  test.describe("search palette", () => {    test("Cmd/Ctrl+K searches the catalog and jumps to the slice in the stream", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en");
      // Hydration gate: the global Ctrl+K listener attaches in a mount effect,
      // so a keypress fired before hydration is silently lost. The client
      // badge only renders after its mount-time fetch resolved — a reliable
      // post-hydration signal in this client-mode suite.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Control+k");
      const input = page.locator("[cmdk-input]");
      await expect(input).toBeVisible();
      await input.fill("zebra");

      const hit = page
        .locator("[cmdk-item]")
        .filter({ hasText: "Zebra quantum retrospective" });
      await expect(hit).toBeVisible();
      await hit.click();

      // The palette closes and the stream jump lands on S07 (already inside
      // the initial page, so the travel clock is the only wait).
      await expect(page.locator("[cmdk-input]")).toHaveCount(0);
      await expect(
        page.getByText(sentinel(slices[7], "user")),
      ).toBeVisible();
      await expect(
        page.getByText(sentinel(slices[7], "agent")),
      ).toBeVisible();
    });
  });

  test.describe("/timeline route", () => {
    // The first /timeline hit compiles the three.js chunk in dev — allow
    // triple the default timeout.
    test("direct URL renders the full-page timeline view", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());

      const res = await page.goto("/en/timeline");
      expect(res?.status()).toBe(200);
      // URL 即模式: the header switcher shows the timeline segment active.
      await expect(
        page
          .getByRole("group", { name: "Switch view" })
          .getByRole("button", { name: "Timeline" }),
      ).toHaveAttribute("aria-pressed", "true");

      // WebGL branch: the R3F canvas + gesture hint. No-WebGL branch: the
      // wheel fallback. The 3D scene itself stays out of assertions (§9).
      if (await probeWebGL(page)) {
        await expect(page.locator("canvas").first()).toBeVisible({
          timeout: 30_000,
        });
        // The gesture hint has a desktop ("Scroll through time · Ctrl+scroll
        // to unbraid …") and a touch ("Swipe through time …") variant — the
        // runner machine decides which.
        await expect(page.getByText(/through time/)).toBeVisible();
        // §5.1 Rev 2: the NOW convergence point is a DOM button (drei Html).
        await expect(
          page.getByRole("button", { name: "NOW", exact: true }),
        ).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(
          page.getByText(/doesn't support WebGL/),
        ).toBeVisible();
        await expect(page.getByText(/2026\/02\//).first()).toBeVisible();
      }
    });

    test("mode switcher opens the timeline overlay over the live chat page", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en");
      await expect(
        page
          .getByRole("group", { name: "Switch view" })
          .getByRole("button", { name: "Chat" }),
      ).toHaveAttribute("aria-pressed", "true");
      // Hydration gate before clicking (the onClick attaches on mount) — the
      // client badge only renders after its mount-time fetch resolved.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();

      // Soft navigation → the intercepted route renders the overlay; the URL
      // becomes /timeline while the chat page never unmounts.
      await page
        .getByRole("group", { name: "Switch view" })
        .getByRole("button", { name: "Timeline" })
        .click();
      await expect(page).toHaveURL(/\/en\/timeline/);
      // Header pill + the overlay's own dark pill.
      await expect(page.getByRole("group", { name: "Switch view" })).toHaveCount(2);
      // The chat input survives under the overlay (chat 常驻, §6.1).
      await expect(page.locator("textarea")).toBeAttached();

      // The overlay renders the same scene/fallback as the full page.
      if (await probeWebGL(page)) {
        await expect(page.locator("canvas").first()).toBeVisible({
          timeout: 30_000,
        });
      } else {
        await expect(
          page.getByText(/doesn't support WebGL/),
        ).toBeVisible();
      }

      // The overlay's own Chat segment closes it — back to the untouched chat.
      await page
        .getByRole("group", { name: "Switch view" })
        .nth(1)
        .getByRole("button", { name: "Chat" })
        .click();
      await expect(page).toHaveURL(/\/en\/?$/);
      await expect(page.getByRole("group", { name: "Switch view" })).toHaveCount(1);
      await expect(page.locator("textarea")).toBeAttached();
    });

    test("Cmd/Ctrl+. toggles between the two view modes", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en");
      // Same hydration gate as the search palette test — the Ctrl+. listener
      // attaches on mount.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Control+.");
      await expect(page).toHaveURL(/\/en\/timeline/);
      // Wait for the scene to actually render before toggling back: a
      // router.push issued while the /timeline navigation is still in flight
      // is silently dropped (observed in the full-suite run), swallowing the
      // return toggle. Same scene-ready gate as the overlay test above.
      if (await probeWebGL(page)) {
        await expect(page.locator("canvas").first()).toBeVisible({
          timeout: 30_000,
        });
      } else {
        await expect(
          page.getByText(/doesn't support WebGL/),
        ).toBeVisible();
      }
      await page.keyboard.press("Control+.");
      await expect(page).toHaveURL(/\/en\/?$/);
    });
  });

  test.describe("3D scene (Rev 7)", () => {
    /** One synthetic zoom step (Playwright modifier+wheel doesn't propagate
     *  ctrlKey into the WheelEvent — dispatch it explicitly). */
    async function zoomStep(page: Page, dir: "in" | "out") {
      await page.evaluate((deltaY) => {
        const canvas = document.querySelector("canvas");
        const el = canvas?.parentElement ?? canvas;
        el?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, dir === "in" ? -240 : 240);
    }

    /** Wheel-up bursts toward the oldest loaded entries (paging trigger). */
    async function scrollOlder(page: Page) {
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        const el = canvas?.parentElement ?? canvas;
        for (let i = 0; i < 6; i++) {
          el?.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -480,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      });
    }

    const cardCount = (page: Page) => page.locator(".tl-card-in").count();

    test("zoom steps across the three levels with cards at every level", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());
      await page.goto("/en/timeline");
      if (!(await probeWebGL(page))) {
        await expect(
          page.getByText(/doesn't support WebGL/),
        ).toBeVisible();
        return;
      }
      // Landing is the day level — cards mount once the scene boots.
      await expect
        .poll(() => cardCount(page), { timeout: 30_000 })
        .toBeGreaterThan(0);

      // Out → week: the window empties only during the flight, never after.
      await zoomStep(page, "out");
      await expect
        .poll(() => cardCount(page), { timeout: 10_000 })
        .toBeGreaterThan(0);

      // In → day → hour: cards render at every level.
      await zoomStep(page, "in");
      await expect
        .poll(() => cardCount(page), { timeout: 10_000 })
        .toBeGreaterThan(0);
      await zoomStep(page, "in");
      await expect
        .poll(() => cardCount(page), { timeout: 10_000 })
        .toBeGreaterThan(0);
    });

    test("an hour-level card click opens the reading panel; Esc closes it", async ({
      page,
    }) => {
      test.slow();
      const slices = datasetA();
      await seedSlices(slices);
      await page.goto("/en/timeline");
      if (!(await probeWebGL(page))) return;
      await expect
        .poll(() => cardCount(page), { timeout: 30_000 })
        .toBeGreaterThan(0);

      // Day → hour, then click the first card (direct dispatch — the easing
      // camera never sits still long enough for actionability checks). Gate
      // on the HOUR-level card width (w-72 = 288px vs the day's 224px): the
      // frozen flight probe still reports the old level, so an early click
      // would drill instead of focusing.
      await zoomStep(page, "in");
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              [...document.querySelectorAll(".tl-card-in")].some(
                (c) => (c as HTMLElement).offsetWidth >= 280,
              ),
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      await page.evaluate(() => {
        document
          .querySelector(".tl-card-in")
          ?.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
      });

      const panel = page.locator("aside[role=dialog]");
      await expect(panel).toBeVisible();
      // The panel carries the slice's full turn flow (§R7.3) — a sentinel
      // turn proves real content loaded, not just the catalog metadata.
      await expect(panel.getByText(/TURN S\d\d user question/).first()).toBeVisible({
        timeout: 15_000,
      });

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    });

    test("scrolling to the top prefetches the older catalog window (§R7.4)", async ({
      page,
    }) => {
      test.slow();
      // Jan/Feb are the prefetch target (one slice each); Mar/Apr are dense
      // enough that the initial 2-month window's scene is TALLER than the
      // top-edge trigger band (max(10, visibleHalf×3) world units) — with a
      // short scene the prefetch legitimately fires at boot and the
      // initial-window assertion below can't tell boot from scroll.
      const slices = [
        makeSlice(new Date(Date.UTC(2026, 0, 12, 9)).toISOString(), { tag: "M1" }),
        makeSlice(new Date(Date.UTC(2026, 1, 12, 9)).toISOString(), { tag: "M2" }),
        ...[3, 6, 9, 12, 15, 18, 21, 24].map((d, i) =>
          makeSlice(new Date(Date.UTC(2026, 2, d, 9)).toISOString(), {
            tag: `MA${i}`,
          }),
        ),
        ...[2, 5, 8, 11, 14, 17, 20, 23].map((d, i) =>
          makeSlice(new Date(Date.UTC(2026, 3, d, 9)).toISOString(), {
            tag: `MB${i}`,
          }),
        ),
      ];
      await seedSlices(slices);
      await page.goto("/en/timeline");
      if (!(await probeWebGL(page))) return;
      await expect
        .poll(() => cardCount(page), { timeout: 30_000 })
        .toBeGreaterThan(0);

      const regionLabels = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("div")]
            .map((d) => (d.children.length === 0 ? d.textContent?.trim() : null))
            .filter((t): t is string => !!t && /^\d{2}\/\d{2}/.test(t)),
        );
      // Initially only Mar/Apr labels.
      const initial = await regionLabels();
      expect(initial.every((t) => t!.startsWith("03/") || t!.startsWith("04/"))).toBe(
        true,
      );

      // Scroll up until the prefetch lands (Feb or Jan label appears) —
      // bounded attempts so a regression fails instead of hanging.
      let seen: string[] = [];
      for (let burst = 0; burst < 15; burst++) {
        await scrollOlder(page);
        await page.waitForTimeout(900);
        seen = await regionLabels();
        if (seen.some((t) => t!.startsWith("02/") || t!.startsWith("01/"))) break;
      }
      expect(
        seen.some((t) => t!.startsWith("02/") || t!.startsWith("01/")),
        `expected an older-month region label after scrolling up, got ${JSON.stringify(seen)}`,
      ).toBe(true);
    });
  });
});

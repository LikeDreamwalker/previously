"use client";

/**
 * TimelineScene (Rev 10) — the shared client component behind both forms
 * of the /timeline route (full page and intercepted overlay).
 *
 * Layout: LEFT = the ambient ruler (fine matte engraved spine with
 * scroll-linked year/month ticks and 1px strand filaments) with the strand
 * filter chip floating on it; RIGHT = the CardField, one R3F scene of big film-frame
 * cards (the top card of every stack is the full original slice card — never
 * a summary) with real 3D backing sheets, deal/collect displacement
 * animations, and viewport virtualization.
 *
 * Owns the catalog window (§R7.4, unchanged): starts from the server's latest
 * months and prepends older windows when the field nears the top. Also owns
 * the reading panel (L0 card click → dock the slice's turn flow).
 *
 * The card-field R3F scene loads via next/dynamic ssr:false; the ambient
 * ruler is a Canvas 2D component also loaded ssr:false. Without WebGL the
 * DOM StackList fallback takes the full width.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "@teispace/next-themes";
import { useReducedMotion } from "motion/react";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  getSliceContent,
  getStrandList,
  getTimelineCatalogPage,
  type SliceContent,
  type StrandListItem,
} from "@/lib/episodic/actions";
import { filterByStrand } from "@/lib/timeline3d/stacks";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import { TimelineFallback } from "./timeline-fallback";
import { StackList } from "./stack-list";
import { StrandFilter } from "./strand-filter";
import { ReadingPanel } from "./reading-panel";

const AmbientScene = dynamic(() => import("./ambient-scene"), {
  ssr: false,
  loading: () => null,
});
const CardField = dynamic(
  () => import("./card-field").then((m) => m.CardField),
  { ssr: false, loading: () => null },
);

/** Fibers the ambient scene draws at most (most recent first). */
const AMBIENT_STRAND_CAP = 12;

export interface TimelineSceneProps {
  /** The initial catalog window (oldest → newest), the latest months. */
  initialEntries: TimelineSliceEntry[];
  /** Month key (YYYY-MM) of the oldest loaded entry — the next page's
   *  `before` cursor. */
  initialOldestMonth: string | null;
  /** Whether entries older than the initial window exist. */
  initialHasMore: boolean;
  /** Slice id from `?at=` — the list lands on it, flashed. */
  initialAtId?: string;
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl"),
    );
  } catch {
    return false;
  }
}

interface ReadingState {
  entry: TimelineSliceEntry;
  content: SliceContent | null;
  contentState: "loading" | "ready" | "failed";
}

/** The bottom fade + NOW marker overlaid on the card field. */
function NowTail() {
  const t = useTranslations("timeline3d");
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
      <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-[1px]"
          style={{ backgroundColor: "var(--primary)" }}
        />
        {t("now.label")} · {t("now.sub")}
      </div>
    </>
  );
}

export function TimelineScene({
  initialEntries,
  initialOldestMonth,
  initialHasMore,
  initialAtId,
}: TimelineSceneProps) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const reducedMotion = useReducedMotion() ?? false;
  // null = not yet checked (first client render matches the server shell).
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => {
    setWebgl(detectWebGL());
  }, []);

  const [entries, setEntries] = useState(initialEntries);
  const [oldestMonth, setOldestMonth] = useState(initialOldestMonth);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const loadingRef = useRef(false);

  /** Calendar range for the left ruler: oldest loaded slice → today. */
  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (entries.length === 0) return { oldest: today, now: today };
    return { oldest: entries[0].date, now: today };
  }, [entries]);

  const [strand, setStrand] = useState<string | null>(null);
  const [strandList, setStrandList] = useState<StrandListItem[]>([]);
  const [reading, setReading] = useState<ReadingState | null>(null);
  /** Card-field scroll progress 0..1 — the threadline reads it per frame. */
  const progressRef = useRef(1);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingRef.current || !oldestMonth) return;
    loadingRef.current = true;
    try {
      const page = await getTimelineCatalogPage(oldestMonth);
      if (page.entries.length === 0) {
        setHasMore(false);
        return;
      }
      // Dedupe defensively: a month already present means we raced a
      // previous prepend — merge by id instead of duplicating cards.
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const older = page.entries.filter((e) => !have.has(e.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      setOldestMonth(page.oldestMonth);
      setHasMore(page.hasMore);
    } catch {
      // A failed prefetch is silent: the list just finds no older rows and
      // the next edge approach retries.
    } finally {
      loadingRef.current = false;
    }
  }, [hasMore, oldestMonth]);

  // The selector's strand list covers the FULL catalog (server side), not
  // just the loaded window.
  useEffect(() => {
    let cancelled = false;
    getStrandList()
      .then((list) => {
        if (!cancelled) setStrandList(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openSlice = useCallback(
    (sliceId: string) => {
      const entry = entries.find((e) => e.id === sliceId);
      if (!entry) return;
      setReading({ entry, content: null, contentState: "loading" });
      getSliceContent(sliceId)
        .then((content) =>
          setReading((cur) =>
            cur?.entry.id === sliceId
              ? { entry, content, contentState: content ? "ready" : "failed" }
              : cur,
          ),
        )
        .catch(() =>
          setReading((cur) =>
            cur?.entry.id === sliceId
              ? { entry, content: null, contentState: "failed" }
              : cur,
          ),
        );
    },
    [entries],
  );

  const filtered = filterByStrand(entries, strand);
  const ambientStrands = strandList
    .slice(0, AMBIENT_STRAND_CAP)
    .map((s) => s.name);

  if (webgl === null) return <TimelineFallback />;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      <div className="relative flex h-full">
        {/* LEFT: the threadline + the filter chip. Pure visual; absent
            entirely without WebGL (the DOM list takes the width). */}
        {webgl && (
          <div className="relative w-14 shrink-0 md:w-44">
            <AmbientScene
              strands={ambientStrands}
              selected={strand}
              progressRef={progressRef}
              range={range}
            />
            {/* Fade-out at the ruler band's edges (bottom weaker so the NOW
                dot stays visible). */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-background to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/60 to-transparent" />
            <div className="absolute left-2 top-3 md:left-3">
              <StrandFilter
                strands={strandList}
                selected={strand}
                onSelect={setStrand}
              />
            </div>
          </div>
        )}

        {/* RIGHT: the card field (R3F), or the DOM list without WebGL. */}
        <div className="relative min-w-0 flex-1">
          {webgl ? (
            <>
              <CardField
                entries={filtered}
                hasMore={hasMore}
                onNeedOlder={loadOlder}
                onOpenSlice={openSlice}
                initialAtId={initialAtId}
                genKey={strand ?? "core"}
                dark={resolvedTheme !== "light"}
                reducedMotion={reducedMotion}
                progressRef={progressRef}
              />
              {/* NOW tail marker — the field's bottom is the present. */}
              <NowTail />
            </>
          ) : (
            <StackList
              entries={filtered}
              hasMore={hasMore}
              onNeedOlder={loadOlder}
              onOpenSlice={openSlice}
              initialAtId={initialAtId}
              genKey={strand ?? "core"}
              pile3d={false}
            />
          )}
        </div>
      </div>

      <AtmosphereVignette />

      {reading && (
        <ReadingPanel
          entry={reading.entry}
          content={reading.content}
          contentState={reading.contentState}
          onClose={() => setReading(null)}
          onTraverse={(sliceId) => router.push(`/?at=${sliceId}`)}
        />
      )}
    </div>
  );
}

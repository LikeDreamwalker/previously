"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import type { UIMessage } from "ai";
import { Loader2, History } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ChatMessage } from "./chat-message";
import { HistoryTurn } from "./history-turn";
import { SliceSeam, formatSeamDate } from "./slice-seam";
import { StreamTimeIndicator } from "./stream-time-indicator";
import { StreamTimeRail } from "./stream-time-rail";
import { EmptyBriefing } from "./empty-briefing";
import { ErrorBanner } from "./error-banner";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  computeRailNodes,
  type RailNode,
  type RailNodeInput,
} from "@/lib/chat/time-rail";
import type { HistoryStreamItem } from "@/lib/chat/stream-items";
import type { SliceSummary } from "@/lib/episodic/actions";

/** A live message rendered through the full chat renderer (tool states,
 *  housekeeping cards, phase indicators — design §1.2's live/history split).
 *  Display props are precomputed by the parent so items stay plain data. */
export interface LiveStreamItem {
  kind: "live";
  key: string;
  message: UIMessage;
  timeIso: string;
  isStreaming: boolean;
  startedAt?: string;
  onRegenerate?: () => void;
}

export type ChatStreamItem = HistoryStreamItem | LiveStreamItem;

/** How long after the scroll stops before the time indicator fades (§1.3). */
const INDICATOR_HOLD_MS = 1000;

interface UnifiedChatStreamProps {
  items: ChatStreamItem[];
  firstItemIndex: number;
  loadingOlder: boolean;
  /** Fired when the scroller reaches the top — the parent pages older slices
   *  and shifts firstItemIndex by the returned count. */
  onStartReached: () => void;
  error: Error | undefined;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  /** Reports the top visible item's time (the travel clock's "from") and the
   *  slice it belongs to (the mode switcher's `?at=` anchor; null = live). */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** Briefing-mode arrival card props (§1.2 Rev 2). When set, the parent seats
   *  a `briefing` item at the stream tail and it renders through these. */
  briefing?: {
    persona?: string;
    active: SliceSummary | null;
    recent: SliceSummary[];
    onSend: (message: string) => void;
  } | null;
}

/** The "继续 <date> 的对话" banner — the light top hint of a resumed
 *  conversation (design §2), sitting directly above the restored turns. */
function ResumeBanner({ startIso }: { startIso: string }) {
  const t = useTranslations("chat.resume");
  const locale = useLocale();
  return (
    <div className="my-4 flex justify-center pr-4 sm:pr-6 lg:pr-8">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/25 bg-brand-500/8 px-3 py-1 text-[0.65rem] font-medium text-brand-600 dark:text-brand-400">
        <History className="h-3 w-3" />
        {t("banner", { date: formatSeamDate(startIso, locale) })}
      </span>
    </div>
  );
}

/**
 * The unified message stream (v0.10 §1): ONE continuous, virtualized,
 * bottom-anchored list — historical slice blocks (seam header + plain-body
 * turns) above, live turns below. Pure presentation: the parent owns the
 * items, the paging and the firstItemIndex bookkeeping.
 */
export function UnifiedChatStream({
  items,
  firstItemIndex,
  loadingOlder,
  onStartReached,
  error,
  virtuosoRef,
  onTopItemChange,
  briefing,
}: UnifiedChatStreamProps) {
  const tSeam = useTranslations("chat.seam");

  // ── Scroll-transient time chrome (§1.3): floating indicator on mobile,
  //  left time rail on desktop — both share this visibility lifecycle. ─────
  // rAF-throttled read of the top visible item (the wheel's scroll-throttle
  // precedent), shown while scrolling, faded 1s after it stops.
  const [indicatorTime, setIndicatorTime] = useState<string | null>(null);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const firstIndexRef = useRef(firstItemIndex);
  firstIndexRef.current = firstItemIndex;
  const onTopItemChangeRef = useRef(onTopItemChange);
  onTopItemChangeRef.current = onTopItemChange;
  const rafRef = useRef<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRangeChanged = useCallback((range: ListRange) => {
    if (rafRef.current !== null) return; // one read per frame
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const rel = range.startIndex - firstIndexRef.current;
      const item = itemsRef.current[rel] ?? itemsRef.current[0];
      if (!item) return;
      setIndicatorTime(item.timeIso);
      // The slice the top item belongs to — seam/resume keys carry the NEWER
      // slice's id ("seam-<id>" / "resume-<id>", see stream-items.ts); live
      // items are "now" (null).
      const sliceId =
        item.kind === "history-turn"
          ? item.sliceId
          : item.kind === "seam"
            ? item.key.slice("seam-".length)
            : item.kind === "resume-banner"
              ? item.key.slice("resume-".length)
              : null;
      onTopItemChangeRef.current?.(item.timeIso, sliceId);
    });
  }, []);

  const handleIsScrolling = useCallback((scrolling: boolean) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (scrolling) {
      setIndicatorVisible(true);
    } else {
      hideTimerRef.current = setTimeout(
        () => setIndicatorVisible(false),
        INDICATOR_HOLD_MS,
      );
    }
  }, []);

  useEffect(
    () => () => {
      // Reset the refs to null after cancelling — otherwise a dev StrictMode
      // remount cancels the pending rAF but leaves the stale id in the ref,
      // and every later updateRail/handleRangeChanged call early-returns on
      // the `!== null` guard: the rail/range reporting would be dead forever.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (railRafRef.current !== null) {
        cancelAnimationFrame(railRafRef.current);
        railRafRef.current = null;
      }
    },
    [],
  );

  // ── Left time rail (§1.3 Rev 2, desktop) ───────────────────────────────
  // Nodes anchor the VISIBLE turns: Virtuoso tags every item wrapper with
  // `data-index`, so a DOM read of the scroller maps rects back to stream
  // items and their `timeIso`. rAF-throttled, updated on scroll / range
  // changes / item changes; geometry math is pure (lib/chat/time-rail.ts).
  // Mobile keeps the floating indicator — the rail never mounts there.
  const isMobile = useIsMobile();
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const [railNodes, setRailNodes] = useState<RailNode[]>([]);
  const [railRect, setRailRect] = useState<{ top: number; height: number }>({
    top: 0,
    height: 0,
  });
  const railRafRef = useRef<number | null>(null);

  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    // We never set customScrollParent, so the scroller is always an element.
    const el = ref instanceof HTMLElement ? ref : null;
    scrollerElRef.current = el;
    setScrollerEl(el);
  }, []);

  const updateRail = useCallback(() => {
    if (railRafRef.current !== null) return; // one read per frame
    railRafRef.current = requestAnimationFrame(() => {
      railRafRef.current = null;
      const el = scrollerElRef.current;
      if (!el) return;
      const containerRect = el.getBoundingClientRect();
      const inputs: RailNodeInput[] = [];
      el.querySelectorAll("[data-index]").forEach((node) => {
        const idx = Number((node as HTMLElement).dataset.index);
        if (!Number.isFinite(idx)) return;
        // Virtuoso's `data-index` is the 0-based DATA index (its internal
        // `originalIndex`) — NOT shifted by firstItemIndex (the shifted one
        // rides `data-item-index`), so it indexes `items` directly.
        const item = itemsRef.current[idx];
        // Turn granularity only (§1.3) — seams/banners anchor no node.
        if (!item || (item.kind !== "history-turn" && item.kind !== "live"))
          return;
        const r = (node as HTMLElement).getBoundingClientRect();
        inputs.push({
          key: item.key,
          timeIso: item.timeIso,
          top: r.top - containerRect.top,
          height: r.height,
        });
      });
      setRailRect({ top: containerRect.top, height: containerRect.height });
      setRailNodes(computeRailNodes(inputs, containerRect.height));
    });
  }, []);

  useEffect(() => {
    if (!scrollerEl || isMobile) {
      setRailNodes([]);
      return;
    }
    const onScroll = () => updateRail();
    scrollerEl.addEventListener("scroll", onScroll, { passive: true });
    updateRail();
    return () => scrollerEl.removeEventListener("scroll", onScroll);
  }, [scrollerEl, isMobile, updateRail]);

  // Prepend/live-append changes rects without a scroll event.
  useEffect(() => {
    if (!isMobile) updateRail();
  }, [items, isMobile, updateRail]);

  // ── Item rendering ──────────────────────────────────────────────────────
  const renderItem = useCallback((_index: number, item: ChatStreamItem) => {
    switch (item.kind) {
      case "seam":
        return (
          <div className="pr-4 sm:pr-6 lg:pr-8">
            <SliceSeam seam={item.seam} dateIso={item.dateIso} />
          </div>
        );
      case "resume-banner":
        return <ResumeBanner startIso={item.startIso} />;
      case "briefing":
        // §1.2 Rev 2 — the arrival briefing seated at the stream's tail.
        return briefing ? (
          <EmptyBriefing
            variant="card"
            persona={briefing.persona}
            active={briefing.active}
            recent={briefing.recent}
            onSend={briefing.onSend}
          />
        ) : null;
      case "history-turn":
        return (
          <div className="pr-4 sm:pr-6 lg:pr-8">
            <HistoryTurn
              role={item.turn.role}
              content={item.turn.content}
              sliceId={item.sliceId}
              turnId={item.turn.turnId}
              timestamp={item.turn.timestamp}
            />
          </div>
        );
      case "live":
        return (
          <div className="pr-4 sm:pr-6 lg:pr-8">
            <ChatMessage
              message={item.message}
              isStreaming={item.isStreaming}
              startedAt={item.startedAt}
              onRegenerate={item.onRegenerate}
            />
          </div>
        );
    }
  }, [briefing]);

  // Virtuoso's Header/Footer take no props — memoized closures over state.
  const Header = useMemo(
    () =>
      function StreamHeader() {
        return (
          <div className="pr-4 pt-3 sm:pr-6 lg:pr-8">
            {loadingOlder && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {tSeam("loadingOlder")}
              </div>
            )}
          </div>
        );
      },
    [loadingOlder, tSeam],
  );

  const Footer = useMemo(
    () =>
      function StreamFooter() {
        return (
          <div className="pr-4 sm:pr-6 lg:pr-8">
            {error && <ErrorBanner error={error} />}
            {/* Safe area clearing the fixed bottom input bar (was pb-36). */}
            <div className="h-36" />
          </div>
        );
      },
    [error],
  );

  // The components object itself must be referentially stable too — a fresh
  // `{ Header, Footer }` literal every render makes Virtuoso tear down and
  // re-measure the header/footer on EVERY scroll-driven setState (indicator,
  // rail), which feeds its size-compensation loop.
  const components = useMemo(() => ({ Header, Footer }), [Header, Footer]);

  // ── Bottom-follow, hand-rolled (Rev 2 arrival bug) ───────────────────────
  // Virtuoso's followOutput="auto" scrolls to ITS computed bottom on every
  // size change — and that bottom is derived from internal totalHeight, which
  // undershoots the real DOM bottom by ~280px while unmeasured-item estimates
  // are in play. Net effect on arrival: even wheel scrolling toward the tail
  // got dragged back on every resize — the last ~280px (briefing card +
  // footer) were unreachable (design doc §11). We track atBottom ourselves
  // and pin to the DOM max instead: on a tail append, and on every items
  // change while a live turn is streaming. Note this deliberately does NOT
  // re-pin on pure resizes, so the arrival landing can sit a little above
  // the tail until the user scrolls — the accepted Rev 2 remainder.
  const atBottomRef = useRef(true);
  const handleAtBottomChange = useCallback((at: boolean) => {
    atBottomRef.current = at;
  }, []);
  const liveStreaming = items.some((i) => i.kind === "live" && i.isStreaming);
  const prevCountRef = useRef(items.length);
  useEffect(() => {
    const grew = items.length > prevCountRef.current;
    prevCountRef.current = items.length;
    if (!atBottomRef.current || (!grew && !liveStreaming)) return;
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
    });
    return () => cancelAnimationFrame(raf);
  }, [items, liveStreaming, virtuosoRef]);

  return (
    <div className="relative mx-auto h-full max-w-5xl xl:max-w-7xl">
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        className="h-full"
        data={items}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        computeItemKey={(_index, item) => item.key}
        startReached={onStartReached}
        atBottomStateChange={handleAtBottomChange}
        isScrolling={handleIsScrolling}
        rangeChanged={handleRangeChanged}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        // Height prior for not-yet-rendered items (real rows: seam ~26, turns
        // 74-156) — narrows the gap between Virtuoso's internal totalHeight
        // and the real DOM bottom, so atBottomStateChange means what it says.
        defaultItemHeight={90}
        itemContent={renderItem}
        components={components}
      />
      {/* §1.3 Rev 2: desktop gets the left time rail (turn-granular nodes);
          mobile keeps the floating indicator. */}
      {isMobile ? (
        <StreamTimeIndicator timeIso={indicatorTime} visible={indicatorVisible} />
      ) : (
        <StreamTimeRail
          nodes={railNodes}
          visible={indicatorVisible}
          top={railRect.top}
          height={railRect.height}
        />
      )}
    </div>
  );
}

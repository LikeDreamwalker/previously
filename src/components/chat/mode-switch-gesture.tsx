"use client";

/**
 * The card-style horizontal swipe that switches chat → timeline mode
 * (v0.10 §5.2 手势表 / §6.1 Rev 2 主入口).
 *
 * Mechanics: motion `drag="x"` with `dragDirectionLock` — the first few
 * pixels decide the axis; only a HORIZONTAL lock claims the gesture, a
 * vertical start stays with Virtuoso's native scroll (`touch-action: pan-y`
 * keeps vertical panning native on touch). The card drags freely left up to
 * a hard stop and rubber-bands right (there is no mode to the right of
 * chat); releasing past the displacement/velocity threshold
 * (lib/chat/mode-gesture.ts) COMMITS: the card keeps flying left (the
 * loading state — a committed switch is a routed navigation, per §5.2 never
 * a 1:1 cross-drag) and the route push carries the viewport slice as `?at=`.
 * Under threshold the card springs home.
 *
 * Conflict handling:
 * - Drag start is MANUAL (dragListener=false + dragControls) so pointer-downs
 *   on interactive chrome (buttons, links, inputs, copy buttons, contenteditable)
 *   never become mode drags.
 * - The direction lock resolves text-selection/long-press: vertical and
 *   diagonal-down starts behave exactly as before; only an unambiguous
 *   horizontal drag is claimed (a deliberate horizontal mouse drag over text
 *   switches mode instead of extending a selection — accepted trade-off,
 *   selection via double-click/keyboard is unaffected).
 * - The header switcher and `Cmd/Ctrl+.` remain as the discoverable fallback.
 *
 * The chat page never unmounts under the timeline overlay, so the card is
 * reset (spring back to rest) as soon as the route is chat again.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  motion,
  useAnimationControls,
  useDragControls,
  type PanInfo,
} from "motion/react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { shouldCommitModeSwitch } from "@/lib/chat/mode-gesture";
import { timelineHref } from "@/lib/chat/mode-switch";
import { getViewportSlice } from "@/lib/chat/viewport-slice";

/** Pointer-downs on these targets belong to the element, never to the mode
 *  drag (manual drag start filters them). */
const DRAG_EXEMPT_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

const SPRING_HOME = { type: "spring", stiffness: 480, damping: 38 } as const;
/** Free-drag headroom to the left (beyond the commit distance) — the card
 *  rubber-bands past it, and to the right immediately (dragElastic). */
const DRAG_HEADROOM_PX = 200;

export function ModeSwitchGesture({ children }: { children: ReactNode }) {
  const t = useTranslations("chat.gesture");
  const router = useRouter();
  const pathname = usePathname();
  const dragControls = useDragControls();
  const animateControls = useAnimationControls();
  const [committed, setCommitted] = useState(false);
  const committedRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(DRAG_EXEMPT_SELECTOR)) return;
      dragControls.start(e);
    },
    [dragControls],
  );

  const handleDragEnd = useCallback(
    (_e: PointerEvent, info: PanInfo) => {
      if (committedRef.current) return;
      if (shouldCommitModeSwitch(info.offset.x, info.velocity.x)) {
        committedRef.current = true;
        setCommitted(true);
        void animateControls.start({
          x: "-38%",
          opacity: 0.5,
          transition: { duration: 0.25, ease: "easeOut" },
        });
        router.push(timelineHref(getViewportSlice()));
      } else {
        void animateControls.start({ x: 0, transition: SPRING_HOME });
      }
    },
    [animateControls, router],
  );

  // Back in chat mode (browser back, header switcher, Cmd+.) — the page is
  // still mounted under where the overlay was, so return the card to rest.
  useEffect(() => {
    if (pathname.startsWith("/timeline") || !committedRef.current) return;
    committedRef.current = false;
    setCommitted(false);
    void animateControls.start({ x: 0, opacity: 1, transition: SPRING_HOME });
  }, [pathname, animateControls]);

  return (
    <motion.div
      className="relative"
      data-testid="mode-switch-card"
      style={{ touchAction: "pan-y" }}
      drag="x"
      dragListener={false}
      dragControls={dragControls}
      dragDirectionLock
      dragConstraints={{ left: -DRAG_HEADROOM_PX, right: 0 }}
      dragElastic={0.15}
      animate={animateControls}
      onPointerDown={handlePointerDown}
      onDragEnd={handleDragEnd}
      aria-busy={committed}
    >
      {children}
      {/* Committed = the route transition's loading state (§5.2: 提交后 loading). */}
      {committed && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("openingTimeline")}
          </span>
        </div>
      )}
    </motion.div>
  );
}

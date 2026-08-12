"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Brain } from "lucide-react";
import { getBriefingIdentity, getPreviously } from "@/lib/episodic/actions";
import type { BriefingIdentity, SliceSummary } from "@/lib/episodic/actions";
import { MarkdownRenderer } from "./markdown";
import { PersonaDialog } from "@/components/persona/persona-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ─── Types ──────────────────────────────────────────────────────────────

interface EmptyBriefingProps {
  /** Current persona id (demo mode only — drives the persona switcher). */
  persona?: string;
  /** The most recent slice (its focus / open_loops seed the briefing). May be
   *  null before the mount fetch resolves, or for a brand-new user. */
  active: SliceSummary | null;
  /** The few most recent slices — their focuses seed suggestion chips. */
  recent: SliceSummary[];
  /** Send a message (suggestion chips). */
  onSend: (message: string) => void;
}

interface Chip {
  label: string;
  prompt: string;
}

/** Truncate a long topic to `max` chars for a chip label. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ─── Component ──────────────────────────────────────────────────────────

/**
 * The empty-live briefing — the product's "arrival" moment. A film-title-card
 * framing: a letter-spaced "PREVIOUSLY ON" eyebrow over the user's name, above
 * a soft brand glow, then a hot-start summary drawn from real memory (the last
 * topic, open threads, and contextual suggestion chips). Every section only
 * renders when it has real data — nothing says "上次聊到" followed by nothing.
 * The name doubles as the persona switcher in demo mode; "view full previously"
 * opens the same Previously On dialog used by the historical slice view.
 */
export function EmptyBriefing({
  persona,
  active,
  recent,
  onSend,
}: EmptyBriefingProps) {
  const t = useTranslations("emptyBriefing");
  const [identity, setIdentity] = useState<BriefingIdentity | null>(null);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const [prevContent, setPrevContent] = useState<string | null>(null);

  // Resolve the display name (+ persona list in demo mode).
  useEffect(() => {
    let cancelled = false;
    getBriefingIdentity(persona)
      .then((id) => {
        if (!cancelled) setIdentity(id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [persona]);

  // Lazily fetch the active slice's previously.md only when the dialog opens.
  useEffect(() => {
    if (!prevOpen || !active?.slice_id || prevContent !== null) return;
    let cancelled = false;
    getPreviously(active.slice_id)
      .then((md) => {
        if (!cancelled) setPrevContent(md);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prevOpen, active, prevContent]);

  const name = identity?.name ?? "";
  const focus = active?.focus?.trim() || "";
  const openLoops = (active?.open_loops ?? []).filter((l) => l.trim().length > 0);

  // Suggestion chips — each seeded from real memory, each sends a real message.
  const chips: Chip[] = [];
  if (focus) {
    const prompt = t("chipContinue", { topic: focus });
    chips.push({ label: truncate(prompt, 30), prompt });
  }
  if (openLoops.length > 0) {
    const prompt = t("chipLoops");
    chips.push({ label: prompt, prompt });
  }
  for (const s of recent) {
    const topic = s.focus?.trim();
    if (!topic || (active && s.slice_id === active.slice_id)) continue;
    const prompt = t("chipTopic", { topic });
    chips.push({ label: truncate(prompt, 30), prompt });
    break;
  }

  const hasSections = Boolean(focus) || openLoops.length > 0 || chips.length > 0;

  const sectionLabel = "flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70";

  return (
    <div className="relative flex min-h-[calc(100vh-13rem)] flex-col items-center justify-center overflow-hidden px-4">
      {/* Soft brand glow — the "stage light" behind the title card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[36%] h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-3xl"
      />

      <div className="relative w-full max-w-xl">
        {/* ── Title card ─────────────────────────────────────────────── */}
        <div className="text-center">
          <div className="font-mono text-[0.65rem] uppercase tracking-[0.35em] text-muted-foreground/60">
            {t("eyebrow")}
          </div>
          {identity?.isDemo ? (
            <button
              onClick={() => setPersonaOpen(true)}
              className="mt-3 inline-block text-4xl font-light tracking-tight text-foreground transition-colors hover:text-brand-600 sm:text-5xl dark:hover:text-brand-400"
            >
              {name}
            </button>
          ) : (
            <div className="mt-3 text-4xl font-light tracking-tight text-foreground sm:text-5xl">
              {name}
            </div>
          )}
        </div>

        {/* ── Hot-start briefing — each section only when it has data ── */}
        {hasSections && (
          <div className="mt-12 space-y-7">
            {focus && (
              <section>
                <h3 className={sectionLabel}>
                  <span className="inline-block size-1.5 rounded-full bg-brand-500" />
                  {t("lastTopic")}
                </h3>
                <p className="mt-2 text-base leading-relaxed text-foreground/85">
                  {focus}
                </p>
              </section>
            )}

            {openLoops.length > 0 && (
              <section>
                <h3 className={sectionLabel}>
                  <span className="inline-block size-1.5 rounded-full bg-brand-500" />
                  {t("openLoops")}
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {openLoops.map((loop, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      <span className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                      {loop}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {chips.length > 0 && (
              <section>
                <h3 className={sectionLabel}>
                  <span className="inline-block size-1.5 rounded-full bg-brand-500" />
                  {t("pickUp")}
                </h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {chips.map((chip) => (
                    <button
                      key={chip.prompt}
                      onClick={() => onSend(chip.prompt)}
                      className="rounded-full border border-border/60 px-3.5 py-1.5 text-sm text-foreground/80 transition-colors hover:border-brand-500/50 hover:text-brand-600 dark:hover:text-brand-400"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ── View the full previously ──────────────────────────────── */}
        {active?.slice_id && (
          <div className="mt-12 text-center">
            <button
              onClick={() => setPrevOpen(true)}
              className="text-xs font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              {t("viewFull")} →
            </button>
          </div>
        )}
      </div>

      {/* ── Persona switcher (demo mode) ─────────────────────────────── */}
      {identity?.isDemo && identity.personas && (
        <PersonaDialog
          personas={identity.personas}
          currentId={persona ?? ""}
          open={personaOpen}
          onOpenChange={setPersonaOpen}
        />
      )}

      {/* ── Previously On dialog (same component family as the slice view) ── */}
      <Dialog open={prevOpen} onOpenChange={setPrevOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Brain className="size-4" />
              Previously On
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm leading-relaxed">
            {prevContent ? (
              <MarkdownRenderer content={prevContent} />
            ) : (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t("loading")}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

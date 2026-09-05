"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchSlices } from "@/lib/search/actions";
import type { SearchHit } from "@/lib/search/slice-search";
import { queryKeyword } from "@/lib/search/slice-search";
import { createDebounced } from "@/lib/chat/debounce";
import { splitHighlight } from "@/lib/chat/highlight";
import { requestSliceJump } from "@/lib/chat/slice-jump";
import { formatSeamDate } from "@/components/chat/slice-seam";
import { useRouter } from "@/i18n/navigation";

/** Input-as-you-type debounce for the search action. */
const SEARCH_DEBOUNCE_MS = 250;
/** Cap the rendered result list — the catalog can be long. */
const MAX_RESULTS = 20;

/** A snippet with the keyword runs wrapped in <mark>. */
function HighlightedSnippet({ text, keyword }: { text: string; keyword: string }) {
  return (
    <span className="block truncate text-xs text-muted-foreground">
      {splitHighlight(text, keyword).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="bg-transparent font-medium text-brand-600 dark:text-brand-400">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * The memory-search command palette (v0.10 §3.2) — Cmd/Ctrl+K anywhere, or the
 * header's search button. Searches the SAME catalog functions the recall
 * sub-agent uses (searchSlices → searchCatalog), `#strand` syntax included.
 *
 * Selecting a hit jumps the unified message stream to that slice: the jump
 * bus (slice-jump.ts) routes to ChatPage's page-until-loaded +
 * scroll-to-seam path, whose time-travel clock doubles as the loading state.
 * Used from a non-chat route, the slice id is stashed in the bus and the
 * palette navigates home, where the jump replays on mount.
 */
export function SearchPalette() {
  const t = useTranslations("chat.search");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  // Stale-response guard: a slower earlier request must never overwrite a
  // newer query's results.
  const requestSeq = useRef(0);

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounce the query (trailing edge) — cancelled on unmount.
  const debouncer = useMemo(
    () => createDebounced((q: string) => setDebouncedQuery(q), SEARCH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  useEffect(() => {
    debouncer.call(query);
  }, [query, debouncer]);

  // Search as the debounced query lands (only while open).
  useEffect(() => {
    if (!open) return;
    const q = debouncedQuery.trim();
    const seq = ++requestSeq.current;
    if (!q) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchSlices(q)
      .then((results) => {
        if (requestSeq.current !== seq) return;
        setHits(results);
        setSearching(false);
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        setHits([]);
        setSearching(false);
      });
  }, [debouncedQuery, open]);

  const handleSelect = (sliceId: string) => {
    setOpen(false);
    // Handled in place on the chat page; otherwise stash + navigate home,
    // where ChatPage replays the pending jump once its stream is up.
    const handled = requestSliceJump(sliceId);
    if (!handled) router.push("/");
  };

  const keyword = queryKeyword(debouncedQuery);
  const shown = hits.slice(0, MAX_RESULTS);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("title")}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <SearchIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden sm:inline">{t("trigger")}</span>
        <kbd className="hidden rounded border border-border/60 bg-muted/40 px-1 font-mono text-[0.6rem] text-muted-foreground/70 sm:inline">
          ⌘K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("title")}
      >
        {/* The server does the matching — cmdk's own filter must stay off. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("placeholder")}
          />
          <CommandList>
            <CommandEmpty>
              {searching ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("searching")}
                </span>
              ) : query.trim() ? (
                t("empty", { query: query.trim() })
              ) : (
                t("hint")
              )}
            </CommandEmpty>
            {shown.map((hit) => {
              const snippet = hit.matches[0]?.snippets[0];
              return (
                <CommandItem
                  key={hit.entry.id}
                  value={hit.entry.id}
                  onSelect={handleSelect}
                  // [&>svg]:hidden — CommandItem's trailing CheckIcon would
                  // occupy a row of its own in this stacked layout.
                  className="flex-col items-start gap-0.5 py-2 [&>svg]:hidden"
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
                      {formatSeamDate(hit.entry.start, locale)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {hit.entry.focus || hit.entry.id}
                    </span>
                  </span>
                  {snippet && (
                    <HighlightedSnippet text={snippet} keyword={keyword} />
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

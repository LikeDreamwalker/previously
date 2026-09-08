"use client";

/**
 * StrandFilter (Rev 8 §R8 筛选器, simple v1) — the external selector for the
 * timeline's right field: 核心时间线 (everything) or one strand. A chip over
 * the left ambient strip opens a small palette: search + strands by recent
 * activity. Deliberately standalone for now; the design intent is to merge
 * with the global search palette later.
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { strandColor, STRAND_PALETTE } from "@/lib/timeline3d/layout";
import type { StrandListItem } from "@/lib/episodic/actions";
import { ColorSquare } from "./cards";

export interface StrandFilterProps {
  strands: StrandListItem[];
  selected: string | null;
  onSelect: (strand: string | null) => void;
}

export function StrandFilter({ strands, selected, onSelect }: StrandFilterProps) {
  const t = useTranslations("timeline3d.filter");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return strands;
    return strands.filter((s) => s.name.toLowerCase().includes(q));
  }, [strands, query]);

  const pick = (strand: string | null) => {
    onSelect(strand);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-md bg-card/85 px-2.5 py-1.5 font-mono text-[10.5px] tracking-[0.08em] text-foreground/85 ring-1 ring-foreground/10 backdrop-blur-md transition-shadow hover:ring-foreground/25"
        aria-label={t("label")}
      >
        <ColorSquare
          color={selected ? strandColor(selected) : STRAND_PALETTE[0]}
          className="size-2"
        />
        <span className="truncate">{selected ?? t("all")}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-64 gap-1 p-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("placeholder")}
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          <button
            onClick={() => pick(null)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent ${
              selected === null ? "bg-accent/70" : ""
            }`}
          >
            <ColorSquare color={STRAND_PALETTE[0]} className="size-2" />
            <span className="flex-1 truncate">{t("all")}</span>
          </button>
          {visible.map((s) => (
            <button
              key={s.name}
              onClick={() => pick(s.name)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent ${
                selected === s.name ? "bg-accent/70" : ""
              }`}
            >
              <ColorSquare color={strandColor(s.name)} className="size-2" />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                ×{s.count}
              </span>
            </button>
          ))}
          {visible.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              {t("empty")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

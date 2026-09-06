/**
 * Turn-list skeleton: the catalog says the slice EXISTS before its turns
 * arrive — show the shape of the incoming rows instead of silence.
 * Square punctuation + staggered pulse bars, theme-aware via bg-muted.
 * Shared by the in-scene hour card preview and the reading panel.
 */
export function TurnsSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["88%", "72%", "58%"];
  return (
    <div aria-hidden="true" className="space-y-1.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="inline-block size-1 shrink-0 rounded-[1px] bg-muted-foreground/30" />
          <span
            className="h-2 animate-pulse rounded-full bg-muted-foreground/15"
            style={{
              width: widths[i % widths.length],
              animationDelay: `${i * 120}ms`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

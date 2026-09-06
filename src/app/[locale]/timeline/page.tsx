import { setRequestLocale } from "next-intl/server";
import {
  getTimelineCatalog,
  getTimelineCatalogPage,
} from "@/lib/episodic/actions";
import { TimelineScene } from "@/components/timeline-3d/timeline-scene";

// The catalog is a live projection of memory — render per request, like the
// settings page. The region layout is computed client-side in pure functions
// (cards-per-row depends on the canvas width, doc/design/v0.10.0 §R7.1).
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ at?: string }>;
};

/** Full-page form of /timeline — direct URL entry, refresh, share. */
export default async function TimelinePage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { at } = await searchParams;

  // Month-windowed catalog (§R7.4): the client starts with the latest months
  // and prefetches older windows as the camera nears the top. A deep link
  // (?at=) may point anywhere in history — load the full catalog so the
  // linked slice is always resolvable.
  if (at) {
    const entries = await getTimelineCatalog();
    return (
      <main className="fixed inset-0 pt-12">
        <TimelineScene
          initialEntries={entries}
          initialOldestMonth={entries[0]?.date.slice(0, 7) ?? null}
          initialHasMore={false}
          initialAtId={at}
        />
      </main>
    );
  }

  const page = await getTimelineCatalogPage(null);
  return (
    <main className="fixed inset-0 pt-12">
      <TimelineScene
        initialEntries={page.entries}
        initialOldestMonth={page.oldestMonth}
        initialHasMore={page.hasMore}
      />
    </main>
  );
}

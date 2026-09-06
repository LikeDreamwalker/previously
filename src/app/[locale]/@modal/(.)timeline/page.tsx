import { setRequestLocale } from "next-intl/server";
import {
  getTimelineCatalog,
  getTimelineCatalogPage,
} from "@/lib/episodic/actions";
import { TimelineOverlay } from "@/components/timeline-3d/timeline-overlay";
import { TimelineScene } from "@/components/timeline-3d/timeline-scene";

// Same live-catalog reasoning as the full page.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ at?: string }>;
};

/**
 * Overlay form of /timeline — soft navigation from the header mode switcher
 * intercepts the route and renders this over the chat page (which never
 * unmounts, doc/design/v0.10.0-memory-viz.md §6.1). Same TimelineScene as
 * the full page, wrapped in a dismissable overlay.
 */
export default async function TimelineModalPage({
  params,
  searchParams,
}: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { at } = await searchParams;

  // Same paging contract as the full page: deep links load the full catalog.
  if (at) {
    const entries = await getTimelineCatalog();
    return (
      <TimelineOverlay>
        <TimelineScene
          initialEntries={entries}
          initialOldestMonth={entries[0]?.date.slice(0, 7) ?? null}
          initialHasMore={false}
          initialAtId={at}
        />
      </TimelineOverlay>
    );
  }

  const page = await getTimelineCatalogPage(null);
  return (
    <TimelineOverlay>
      <TimelineScene
        initialEntries={page.entries}
        initialOldestMonth={page.oldestMonth}
        initialHasMore={page.hasMore}
      />
    </TimelineOverlay>
  );
}

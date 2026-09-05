import { setRequestLocale } from "next-intl/server";
import { getTimelineCatalog } from "@/lib/episodic/actions";
import { computeTimelineLayout } from "@/lib/timeline3d/layout";
import { TimelineScene } from "@/components/timeline-3d/timeline-scene";

// The catalog is a live projection of memory — render per request, like the
// settings page. Layout coordinates are precomputed server-side in a pure
// function; the client scene only renders (doc/design/v0.10.0 §5.3).
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

  const entries = await getTimelineCatalog();
  const layout = computeTimelineLayout(entries);

  return (
    <main className="fixed inset-0 pt-12">
      <TimelineScene layout={layout} initialAtId={at} />
    </main>
  );
}

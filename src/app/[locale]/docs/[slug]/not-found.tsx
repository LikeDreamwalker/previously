import { Link } from "@/i18n/navigation";
import { DEFAULT_DOC_SLUG } from "@/lib/docs/manifest";

export default function DocNotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="text-sm text-muted-foreground">
        This documentation page doesn&apos;t exist yet.
      </p>
      <Link
        href={`/docs/${DEFAULT_DOC_SLUG}`}
        className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
      >
        Back to the docs
      </Link>
    </div>
  );
}

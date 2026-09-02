"use client";

import { useState, useCallback } from "react";
import { BookOpenText, History, Compass } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownRenderer } from "./markdown";
import { getMemoryDocs, type MemoryDocs as MemoryDocsData } from "@/lib/episodic/actions";

type DocKey = "previously" | "direction";

const DOC_ICONS: Record<DocKey, typeof History> = {
  previously: History,
  direction: Compass,
};

/**
 * Memory-docs viewer for the chat toolbar — lets the user peek at the two
 * documents the self-evolution loop produces: the current slice's
 * previously.md snapshot (the latest slice when none is active) and the
 * evolution direction.md portrait. Fetched lazily on popover open (one
 * server-action round trip per open, so the content is always fresh).
 */
export function MemoryDocs({ persona }: { persona?: string }) {
  const t = useTranslations("chat.input");
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<MemoryDocsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeDoc, setActiveDoc] = useState<DocKey | null>(null);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen || loading) return;
      setLoading(true);
      getMemoryDocs(persona)
        .then(setDocs)
        .catch(() =>
          setDocs({ sliceId: null, previously: null, direction: null }),
        )
        .finally(() => setLoading(false));
    },
    [loading, persona],
  );

  const openDoc = (key: DocKey) => {
    setActiveDoc(key);
    setOpen(false);
  };

  const content = activeDoc && docs ? docs[activeDoc] : null;

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center"
                  >
                    <BookOpenText className="h-3.5 w-3.5" />
                  </button>
                }
              />
            }
          />
          <TooltipContent side="top">{t("docsTooltip")}</TooltipContent>
        </Tooltip>

        <PopoverContent align="start" sideOffset={8} className="w-48 p-1.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("docsLabel")}
          </div>
          {(Object.keys(DOC_ICONS) as DocKey[]).map((key) => {
            const Icon = DOC_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => openDoc(key)}
                className="w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 hover:bg-muted"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t(`docs.${key}`)}</span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      <Dialog open={activeDoc !== null} onOpenChange={(o) => !o && setActiveDoc(null)}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {activeDoc && (
                <>
                  {(() => {
                    const Icon = DOC_ICONS[activeDoc];
                    return <Icon className="h-4 w-4" />;
                  })()}
                  {t(`docs.${activeDoc}`)}
                  {activeDoc === "previously" && docs?.sliceId && (
                    <span className="font-mono text-[10px] font-normal text-muted-foreground">
                      {docs.sliceId}
                    </span>
                  )}
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {loading ? (
            <div className="py-4 text-sm text-muted-foreground">{t("docsLoading")}</div>
          ) : content ? (
            <div className="text-sm leading-relaxed">
              <MarkdownRenderer content={content} />
            </div>
          ) : (
            <div className="py-2 text-sm text-muted-foreground italic">
              {t("docsEmpty")}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

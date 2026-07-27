"use client";

import { useState, useCallback } from "react";
import { Brain } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownRenderer } from "./markdown";
import { getTurnCognition } from "@/lib/episodic/actions";

// ─── Types ──────────────────────────────────────────────────────────────

interface CognitionPopoverProps {
  sliceId: string;
  turnId: string;
  /** Trigger label shown in the bubble header row. Defaults to i18n "thoughts". */
  label?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export function CognitionPopover({ sliceId, turnId, label }: CognitionPopoverProps) {
  const t = useTranslations("chat.evolution");
  const displayLabel = label ?? t("thoughts");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const fetchCognition = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getTurnCognition(sliceId, turnId);
      setContent(result);
    } catch {
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [sliceId, turnId]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && content === null && !loading) {
      fetchCognition();
    }
  };

  const hasContent = content !== null && content.length > 0;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        className="cursor-pointer hover:text-foreground transition-colors"
        aria-label="View agent cognition"
      >
        {displayLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4" />
            Thoughts
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Brain className="h-3.5 w-3.5 animate-pulse" />
            Loading thoughts...
          </div>
        ) : hasContent ? (
          <div className="text-sm leading-relaxed">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <div className="py-2 text-sm text-muted-foreground italic">
            No thoughts recorded for this turn.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

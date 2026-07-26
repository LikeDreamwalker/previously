"use client";

import { useState, useCallback } from "react";
import { Brain } from "lucide-react";
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
}

// ─── Component ──────────────────────────────────────────────────────────

export function CognitionPopover({ sliceId, turnId }: CognitionPopoverProps) {
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
        className="inline-flex items-center cursor-pointer opacity-30 hover:opacity-60 transition-opacity"
        aria-label="View agent cognition"
      >
        <Brain className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4" />
            Agent Cognition
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Brain className="h-3.5 w-3.5 animate-pulse" />
            Loading cognition...
          </div>
        ) : hasContent ? (
          <div className="text-sm leading-relaxed">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <div className="py-2 text-sm text-muted-foreground italic">
            No cognition recorded for this turn.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

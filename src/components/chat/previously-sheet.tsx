"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { MarkdownRenderer } from "./markdown";

interface PreviouslySheetProps {
  content: string;
}

/**
 * Slide-out sheet that renders previously.md content with MarkdownRenderer.
 * Opened via a "View" button in the update-previously phase indicator.
 */
export function PreviouslySheet({ content }: PreviouslySheetProps) {
  const t = useTranslations("chat.phase");
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
      >
        {t("viewPreviously")}
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("previouslyTitle")}</SheetTitle>
          <SheetDescription>
            <span className="font-mono text-xs">previously.md</span>
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <MarkdownRenderer content={content} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

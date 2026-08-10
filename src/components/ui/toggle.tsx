"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface ToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
}

function Toggle({ className, pressed, ...props }: ToggleProps) {
  return (
    <button
      type="button"
      data-slot="toggle"
      data-pressed={pressed || undefined}
      aria-pressed={pressed}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full text-[0.6rem] font-medium transition-colors",
        "hover:bg-brand/10 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        pressed
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground/50",
        className
      )}
      {...props}
    />
  );
}

export { Toggle };
export type { ToggleProps };

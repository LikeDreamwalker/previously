"use client";

import { ArrowLeftRight } from "lucide-react";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";

export function HeroText({
  name,
  onNameClick,
  clickable = false,
}: {
  name: string;
  onNameClick?: () => void;
  clickable?: boolean;
}) {
  return (
    <>
      {clickable ? (
        <div
          onClick={onNameClick}
          className="relative mt-3 inline-flex cursor-pointer rounded-xl px-4 py-2 -mx-4 -my-2 hover:bg-brand/10 transition-colors duration-300"
        >
          <TextGenerateEffect
            words={name}
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
            duration={0.5}
            delay={1.1}
            staggerDelay={0.4}
          />
          <ArrowLeftRight
            className="ml-1 h-3 w-3 text-brand-600 dark:text-brand-400 -translate-y-px"
            style={{
              opacity: 0,
              animation: "0.3s ease 2.5s forwards fade-in-icon",
            }}
          />
          <style>{`@keyframes fade-in-icon { from { opacity: 0 } to { opacity: 1 } }`}</style>
        </div>
      ) : (
        <div className="mt-3">
          <TextGenerateEffect
            words={name}
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
            duration={0.5}
            delay={1.1}
            staggerDelay={0.4}
          />
        </div>
      )}
    </>
  );
}

import { Suspense } from "react";
import { setRequestLocale } from "next-intl/server";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { ChatPage } from "@/components/chat/chat-page";
import { HeroSection } from "@/components/chat/hero-section";
import { loadUserConfig } from "@/lib/config/loader";

type SearchParams = Promise<{ persona?: string }>;

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { persona } = await searchParams;
  if (resolveDataSource() === "demo") {
    setDemoPersona(persona || "personal_14");
  }

  // Preload the user config server-side so ChatPage seeds its model/thinking/
  // effort state from real values instead of flashing the defaults and then
  // reconciling via a mount-time server action. The config loader has a 60s TTL
  // and the underlying GitHub read rides the readFile cache, so this is cheap.
  const config = await loadUserConfig();

  return (
    <ChatPage initialConfig={config}>
      {/* Static title — never flashes, always visible */}
      <div className="h-screen flex flex-col items-center justify-center text-center font-[family-name:var(--font-raleway)]">
        <div className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl font-light text-foreground leading-none tracking-tighter">
          Previously on
        </div>
        <Suspense fallback={<div className="mt-3 h-10 w-48 rounded-lg bg-muted animate-pulse" />}>
          <div className="mt-3">
            <HeroSection personaId={persona} />
          </div>
        </Suspense>
      </div>
    </ChatPage>
  );
}

import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { AppHeader } from "@/components/layout/app-header";
import { TimelineOverlayProvider } from "@/components/chat/timeline-overlay-context";
import { resolveDataSource } from "@/lib/data-source/resolve";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const isDemo = resolveDataSource() === "demo";

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <TimelineOverlayProvider>
        <AppHeader isDemo={isDemo} />
        {children}
      </TimelineOverlayProvider>
    </NextIntlClientProvider>
  );
}

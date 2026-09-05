import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { AppHeader } from "@/components/layout/app-header";
import { resolveDataSource } from "@/lib/data-source/resolve";

type Props = {
  children: React.ReactNode;
  /** Parallel-route slot: the intercepted /timeline overlay. Renders null
   *  (via `@modal/default.tsx`) whenever the timeline mode isn't active. */
  modal: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, modal, params }: Props) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const isDemo = resolveDataSource() === "demo";

  return (
    <NextIntlClientProvider messages={messages} locale={locale}>
      <AppHeader isDemo={isDemo} />
      {children}
      {modal}
    </NextIntlClientProvider>
  );
}

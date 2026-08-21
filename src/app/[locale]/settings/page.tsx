import { getTranslations, setRequestLocale } from "next-intl/server";
import { SettingsForm } from "@/components/settings/settings-form";
import { ClientSection } from "@/components/settings/client-section";
import { loadUserConfig } from "@/lib/config/loader";
import { resolveDataSource, isWritable } from "@/lib/data-source/resolve";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const config = await loadUserConfig();
  const source = resolveDataSource();
  const canWrite = isWritable(source);

  return (
    <div className="p-6 max-w-xl mx-auto pt-16">
      <h1 className="text-2xl font-bold mb-2">{t("pageTitle")}</h1>
      <p className="text-muted-foreground text-sm mb-8">
        {t("pageSubtitle")}
      </p>
      <div className="space-y-8">
        <SettingsForm
          initialConfig={config}
          dataSource={source}
          canWrite={canWrite}
        />
        {/* Local client instance panel — renders nothing in cloud mode
            (its status API answers 404 there). Runtime-gated, because this
            page is prerendered at build time when mode is still unknown. */}
        <ClientSection />
      </div>
    </div>
  );
}

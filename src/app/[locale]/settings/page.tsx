import { getTranslations, setRequestLocale } from "next-intl/server";
import { SettingsForm } from "@/components/settings/settings-form";
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
      <SettingsForm
        initialConfig={config}
        dataSource={source}
        canWrite={canWrite}
      />
    </div>
  );
}

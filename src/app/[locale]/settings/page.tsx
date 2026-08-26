import { getTranslations, setRequestLocale } from "next-intl/server";
import { SettingsForm } from "@/components/settings/settings-form";
import { ClientSection } from "@/components/settings/client-section";
import { VersionSection } from "@/components/settings/version-section";
import { Separator } from "@/components/ui/separator";
import { loadUserConfig } from "@/lib/config/loader";
import { DEFAULTS } from "@/lib/config/defaults";
import { resolveDataSource, isWritable } from "@/lib/data-source/resolve";
import { isClientMode } from "@/lib/mode";

// Low-traffic page: skip prerendering so the config is read fresh per request
// (client mode = local disk, zero network; cloud = GitHub with its existing
// 60s caches). Dynamic rendering also makes isClientMode() truthful at render
// time, which the section gating below relies on.
export const dynamic = "force-dynamic";

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
  const clientMode = isClientMode();

  return (
    <div className="p-6 max-w-3xl mx-auto pt-16">
      <h1 className="text-2xl font-bold mb-2">{t("pageTitle")}</h1>
      <p className="text-muted-foreground text-sm mb-8">
        {t(clientMode ? "pageSubtitleClient" : "pageSubtitleCloud")}
      </p>
      <div className="space-y-12">
        {/* 通用 / General — applies in every deployment mode */}
        <section className="space-y-6">
          <GroupHeader
            title={t("groups.general.title")}
            desc={t("groups.general.desc")}
          />
          <SettingsForm
            initialConfig={config}
            defaults={DEFAULTS.slicing}
            dataSource={source}
            canWrite={canWrite}
          />
        </section>

        {/* 本地设置 / Local settings — client mode only (server-gated; the
            section keeps its runtime 404 self-hide as a fallback). */}
        {clientMode && (
          <section className="space-y-6">
            <GroupHeader
              title={t("groups.local.title")}
              desc={t("groups.local.desc")}
            />
            <ClientSection />
          </section>
        )}

        {/* 云端设置 / Cloud settings — cloud only: update check + upstream
            sync are GitHub-template semantics; a client kernel upgrades via
            the client CLI (`previously upgrade`). */}
        {!clientMode && (
          <section className="space-y-6">
            <GroupHeader
              title={t("groups.cloud.title")}
              desc={t("groups.cloud.desc")}
            />
            <VersionSection />
          </section>
        )}
      </div>
    </div>
  );
}

/** Small-caps group title + one-line description + rule. */
function GroupHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground/70">{desc}</p>
      <Separator className="mt-3" />
    </div>
  );
}

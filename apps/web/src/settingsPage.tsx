import { useQuery } from "@tanstack/react-query";

import { fetchSettings } from "./api";
import { JsonPanel, PageState, PageTitle } from "./ui";

export function SettingsPage() {
  const query = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  if (query.isLoading) return <PageState title="Settings" label="Loading organization settings" />;
  if (query.error) return <PageState title="Settings" label={query.error.message} />;
  if (!query.data) return <PageState title="Settings" label="No settings data" />;

  const settings = query.data;
  return (
    <div className="page page-enter">
      <PageTitle title="Settings" subtitle={`Runtime configuration for ${settings.organizationId}.`} />
      <div className="settings-grid">
        <JsonPanel title="Classifier" value={settings.classifier} />
        <JsonPanel title="Budgets" value={settings.budgets} />
        <JsonPanel title="Prompt capture" value={settings.promptCapture} />
        <JsonPanel title="Policy trust" value={settings.routePolicyTrust} />
        <JsonPanel title="Persistence" value={{ databaseEnabled: settings.databaseEnabled }} />
        <JsonPanel title="Secrets" value={{ providerKeys: "secret references only", apiKeys: "stored as hashes" }} />
      </div>
    </div>
  );
}

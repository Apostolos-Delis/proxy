import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { SettingsForm } from "./settingsForm";
import { settingsInput, type EditableSettings } from "./settingsPageData";
import { PageState } from "./ui";

graphql(`
  fragment SettingsViewFields on Settings {
    organizationId
    databaseEnabled
    subscriptionOAuthEnabled
    restartRequiredFor
    storage {
      path
      reason
    }
    settings {
      schemaVersion
      systemPrompt
      cacheTtlUpgrade
      automaticCaching
      toolResultCompression
      costBaseline {
        anthropicModel
        openaiModel
      }
      classifier {
        model
        timeoutMs
        maxAttempts
        allowRedactedExcerpt
      }
      routeQuality {
        lowConfidenceThreshold
      }
      promptCapture {
        promptCaptureMode
        retentionDays
      }
    }
  }
`);

const SettingsViewDocument = graphql(`
  query SettingsView {
    settings {
      ...SettingsViewFields
    }
  }
`);

const UpdateSettingsDocument = graphql(`
  mutation UpdateSettings($input: SettingsInput!) {
    updateSettings(input: $input) {
      ...SettingsViewFields
    }
  }
`);

const ActiveSessionsDocument = graphql(`
  query ActiveSessions {
    activeSessionCount {
      activeSessions
      windowMs
    }
  }
`);

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [savedNeedsRestart, setSavedNeedsRestart] = useState(false);
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await gqlFetch(SettingsViewDocument)).settings
  });
  const activeSessionsQuery = useQuery({
    queryKey: ["active-sessions"],
    queryFn: async () => (await gqlFetch(ActiveSessionsDocument)).activeSessionCount
  });
  const mutation = useMutation({
    mutationFn: async (settings: EditableSettings) =>
      (await gqlFetch(UpdateSettingsDocument, { input: settingsInput(settings) })).updateSettings,
    onSuccess: (data) => queryClient.setQueryData(["settings"], data)
  });

  if (query.isLoading) return <PageState title="Settings" label="Loading organization settings" />;
  if (query.error) return <PageState title="Settings" label={query.error.message} />;
  if (!query.data) return <PageState title="Settings" label="No settings data" />;

  return (
    <div className="page page-enter">
      <SettingsForm
        key={JSON.stringify(query.data.settings)}
        initial={query.data.settings}
        databaseEnabled={query.data.databaseEnabled}
        storagePath={query.data.storage.path}
        storageReason={query.data.storage.reason}
        restartRequiredFor={query.data.restartRequiredFor}
        activeSessions={activeSessionsQuery.data?.activeSessions ?? null}
        activeWindowMs={activeSessionsQuery.data?.windowMs ?? null}
        saving={mutation.isPending}
        justSaved={mutation.isSuccess}
        justSavedRestart={savedNeedsRestart}
        saveError={mutation.error?.message}
        onSave={(settings, needsRestart) => {
          setSavedNeedsRestart(needsRestart);
          mutation.mutate(settings);
        }}
      />
    </div>
  );
}

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
      duplicateToolResultReferences
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

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [savedNeedsRestart, setSavedNeedsRestart] = useState(false);
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await gqlFetch(SettingsViewDocument)).settings
  });
  const mutation = useMutation({
    mutationFn: async (settings: EditableSettings) =>
      (await gqlFetch(UpdateSettingsDocument, { input: settingsInput(settings) })).updateSettings,
    onSuccess: (data) => queryClient.setQueryData(["settings"], data)
  });

  if (queryIsLoading) return <PageState title="Settings" label="Loading organization settings" />;
  if (queryError) return <PageState title="Settings" label={queryError.message} />;
  if (!queryData) return <PageState title="Settings" label="No settings data" />;

  return (
    <div className="page page-enter">
      <SettingsForm
        key={JSON.stringify(queryData.settings)}
        initial={queryData.settings}
        databaseEnabled={queryData.databaseEnabled}
        storagePath={queryData.storage.path}
        storageReason={queryData.storage.reason}
        restartRequiredFor={queryData.restartRequiredFor}
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

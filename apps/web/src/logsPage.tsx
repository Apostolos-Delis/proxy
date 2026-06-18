import { useNavigate, useSearch } from "@tanstack/react-router";

import { RequestLogsTable } from "./requestsPage";
import { SessionLogsTable } from "./sessionsPage";
import { Segmented } from "./ui";

const logViewOptions = [
  { value: "sessions", label: "Sessions" },
  { value: "requests", label: "Requests" }
] as const;

type LogView = typeof logViewOptions[number]["value"];

function logView(value: unknown): LogView {
  return value === "requests" ? "requests" : "sessions";
}

export function LogsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { view?: unknown };
  const view = logView(search.view);
  return (
    <div className="page page-enter">
      <div className="logs-tabs">
        <Segmented
          options={logViewOptions}
          value={view}
          onChange={(next) =>
            void navigate({ to: ".", search: (current) => ({ ...current, view: next === "sessions" ? undefined : next }), replace: true })
          }
        />
      </div>
      {view === "requests" ? <RequestLogsTable /> : <SessionLogsTable />}
    </div>
  );
}

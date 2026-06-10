import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";
import { useState } from "react";

import { createWorkspace, fetchMe, switchWorkspace, type AuthMe } from "./session";
import { PopoverShell } from "./table/PopoverShell";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: async (data: AuthMe) => {
      setOpen(false);
      queryClient.setQueryData(["me"], data);
      void queryClient.invalidateQueries();
      await navigate({ to: "/" });
    }
  });
  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: (workspace) => {
      switchMutation.mutate(workspace.id);
    }
  });

  if (!me) return null;
  const current = me.workspaces.find((workspace) => workspace.id === me.workspaceId);
  const error = switchMutation.error ?? createMutation.error;

  return (
    <div
      className="workspace-switcher"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="workspace-card"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Layers className="workspace-card-icon" />
        <span className="brand-text">
          <strong>{current?.name ?? "Workspace"}</strong>
        </span>
        <ChevronsUpDown className="org-switcher-chevron" />
      </button>
      {open ? (
        <PopoverShell onDismiss={() => setOpen(false)}>
          <div className="workspace-switcher-popover" role="menu">
            <div className="org-switcher-label">Workspaces</div>
            {me.workspaces.map((workspace) => {
              const isCurrent = workspace.id === me.workspaceId;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitem"
                  className={`org-switcher-option${isCurrent ? " active" : ""}`}
                  disabled={switchMutation.isPending}
                  onClick={() => {
                    if (isCurrent) {
                      setOpen(false);
                      return;
                    }
                    switchMutation.mutate(workspace.id);
                  }}
                >
                  <span className="org-switcher-option-meta">
                    <strong>{workspace.name}</strong>
                    <span>{workspace.slug}</span>
                  </span>
                  {isCurrent ? <Check className="workspace-switcher-check" /> : null}
                </button>
              );
            })}
            <CreateWorkspaceRow
              pending={createMutation.isPending || switchMutation.isPending}
              onCreate={(name) => createMutation.mutate({ name })}
            />
            {error ? <p className="form-error">{error.message}</p> : null}
          </div>
        </PopoverShell>
      ) : null}
    </div>
  );
}

function CreateWorkspaceRow({ pending, onCreate }: { pending: boolean; onCreate: (name: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  if (!creating) {
    return (
      <button
        type="button"
        className="org-switcher-option workspace-switcher-new"
        onClick={() => setCreating(true)}
      >
        <Plus className="workspace-switcher-plus" />
        <span className="org-switcher-option-meta">
          <strong>New workspace</strong>
        </span>
      </button>
    );
  }

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    onCreate(trimmed);
  };

  return (
    <div className="workspace-switcher-create">
      <input
        className="workspace-switcher-input"
        autoFocus
        placeholder="Workspace name"
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <button type="button" className="btn btn-sm" disabled={pending || !name.trim()} onClick={submit}>
        Create
      </button>
    </div>
  );
}

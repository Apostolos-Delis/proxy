import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import { useRef, useState } from "react";

import { restartLiveUpdates } from "./liveUpdates";
import { fetchMe, switchOrganization, type AuthMe } from "./session";
import { AnchoredPopover } from "./table/PopoverShell";

export function OrgSwitcher() {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async (data: AuthMe) => {
      setOpen(false);
      queryClient.setQueryData(["me"], data);
      void queryClient.invalidateQueries();
      restartLiveUpdates(queryClient);
      await navigate({ to: "/" });
    }
  });

  if (!me) return null;
  const current = me.organizations.find((org) => org.id === me.organizationId);

  return (
    <div
      className="org-switcher"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        ref={cardRef}
        type="button"
        className="org-card"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="org-avatar">{orgInitial(current?.name)}</span>
        <span className="brand-text">
          <strong>{current?.name ?? me.organizationId}</strong>
          <span>{me.user.role}</span>
        </span>
        <ChevronsUpDown className="org-switcher-chevron" />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={cardRef} onDismiss={() => setOpen(false)}>
          <div className="org-switcher-popover" role="menu">
            <div className="org-switcher-label">Organizations</div>
            {me.organizations.map((org) => {
              const isCurrent = org.id === me.organizationId;
              return (
                <button
                  key={org.id}
                  type="button"
                  role="menuitem"
                  className={`org-switcher-option${isCurrent ? " active" : ""}`}
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (isCurrent) {
                      setOpen(false);
                      return;
                    }
                    mutation.mutate(org.id);
                  }}
                >
                  <span className="org-avatar">{orgInitial(org.name)}</span>
                  <span className="org-switcher-option-meta">
                    <strong>{org.name}</strong>
                    <span>{org.role}</span>
                  </span>
                  {isCurrent ? <span className="org-switcher-current">Current</span> : null}
                </button>
              );
            })}
            {mutation.error ? <p className="form-error">{mutation.error.message}</p> : null}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

function orgInitial(name: string | undefined) {
  const initial = name?.trim().charAt(0).toUpperCase();
  return initial || "?";
}

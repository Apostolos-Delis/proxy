import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, MailPlus } from "lucide-react";
import { useState } from "react";

import { graphql } from "./gql";
import type { MemberRole } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { MenuSelect } from "./table/MenuSelect";
import { FormField as Field, GlassCard, StatusIndicator } from "./ui";

const CreateInvitationDocument = graphql(`
  mutation CreateInvitation($input: CreateInvitationInput!) {
    createInvitation(input: $input) {
      inviteUrl
      emailDelivery {
        transport
        delivered
        error
      }
    }
  }
`);

export type EmailDelivery = {
  transport: string;
  delivered: boolean;
  error?: string | null;
};

export type InvitationActionResult = {
  inviteUrl: string;
  emailDelivery: EmailDelivery;
};

export const memberRoleOptions: { value: MemberRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" }
];

type InviteForm = {
  email: string;
  name: string;
  role: MemberRole;
};

const emptyForm: InviteForm = { email: "", name: "", role: "member" };

export function InviteUserPanel() {
  const [form, setForm] = useState<InviteForm>(emptyForm);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [result, setResult] = useState<InvitationActionResult | null>(null);
  const queryClient = useQueryClient();
  const inviteMutation = useMutation({
    mutationFn: async () => (await gqlFetch(CreateInvitationDocument, {
      input: {
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        role: form.role
      }
    })).createInvitation,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setResult(data);
      setForm(emptyForm);
    }
  });

  return (
    <GlassCard className="inline-create-card">
      <form onSubmit={(event) => {
        event.preventDefault();
        const nextError = validateEmail(form.email);
        setEmailError(nextError);
        if (!nextError) inviteMutation.mutate();
      }}>
        <div className="card-head inline-form-head">
          <div>
            <div className="card-title"><MailPlus />Invite user</div>
            <div className="faint">Send a styled invitation email with a secure accept link.</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? "Sending" : "Send invite"}
          </button>
        </div>
        <div className="inline-form-grid">
          <Field label="Email" error={emailError ?? undefined}>
            <input
              value={form.email}
              onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))}
              placeholder="teammate@example.com"
              autoComplete="off"
            />
          </Field>
          <Field label="Name (optional)">
            <input
              value={form.name}
              onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
              placeholder="Ada Lovelace"
              autoComplete="off"
            />
          </Field>
          <div className="inline-form-field">
            <span>Role</span>
            <MenuSelect
              value={form.role}
              options={memberRoleOptions}
              ariaLabel="Role"
              onChange={(role) => setForm((value) => ({ ...value, role: role as MemberRole }))}
            />
          </div>
        </div>
        {inviteMutation.error ? <div className="action-error">{inviteMutation.error.message}</div> : null}
        {result ? <InviteLinkResult result={result} /> : null}
      </form>
    </GlassCard>
  );
}

export function InviteLinkResult({ result }: { result: InvitationActionResult }) {
  return (
    <div className="invite-result">
      <div className="row gap-8">
        <StatusIndicator status="created">Invite created</StatusIndicator>
        <EmailDeliveryStatus delivery={result.emailDelivery} />
      </div>
      <CopyLink url={result.inviteUrl} />
    </div>
  );
}

export function EmailDeliveryStatus({ delivery }: { delivery: EmailDelivery }) {
  if (delivery.delivered) return <StatusIndicator tone="success">Email sent</StatusIndicator>;
  if (delivery.transport === "log") return <StatusIndicator tone="warn">Email logged (no RESEND_API_KEY)</StatusIndicator>;
  return <StatusIndicator tone="danger">Email failed{delivery.error ? `: ${delivery.error}` : ""}</StatusIndicator>;
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row gap-8 invite-link-row">
      <span className="mono faint invite-link">{url}</span>
      <button
        className="btn btn-sm"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function validateEmail(value: string) {
  const email = value.trim();
  if (!email) return "Email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, MailPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { createInvitation, type EmailDelivery, type InvitationActionResult, type MemberRole } from "./api";
import { Badge, GlassCard } from "./ui";

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
    mutationFn: () => createInvitation({
      email: form.email.trim(),
      name: form.name.trim() || undefined,
      role: form.role
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setResult(data);
      setForm(emptyForm);
    }
  });

  return (
    <GlassCard className="routing-config-create">
      <form onSubmit={(event) => {
        event.preventDefault();
        const nextError = validateEmail(form.email);
        setEmailError(nextError);
        if (!nextError) inviteMutation.mutate();
      }}>
        <div className="card-head routing-create-head">
          <div>
            <div className="card-title"><MailPlus />Invite user</div>
            <div className="faint">Send a styled invitation email with a secure accept link.</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={inviteMutation.isPending}>
            {inviteMutation.isPending ? "Sending" : "Send invite"}
          </button>
        </div>
        <div className="routing-create-grid">
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
          <Field label="Role">
            <select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as MemberRole }))}>
              {memberRoleOptions.map((role) => (
                <option key={role.value} value={role.value}>{role.label}</option>
              ))}
            </select>
          </Field>
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
        <Badge variant="success" dot>Invite created</Badge>
        <EmailDeliveryBadge delivery={result.emailDelivery} />
      </div>
      <CopyLink url={result.inviteUrl} />
    </div>
  );
}

export function EmailDeliveryBadge({ delivery }: { delivery: EmailDelivery }) {
  if (delivery.delivered) return <Badge variant="accent">Email sent</Badge>;
  if (delivery.transport === "log") return <Badge variant="warn">Email logged (no RESEND_API_KEY)</Badge>;
  return <Badge variant="danger">Email failed{delivery.error ? `: ${delivery.error}` : ""}</Badge>;
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

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="routing-create-field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function validateEmail(value: string) {
  const email = value.trim();
  if (!email) return "Email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

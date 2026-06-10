import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, MailX } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatDateTime } from "./format";
import { graphql } from "./gql";
import type { PublicInvitationQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { Badge, ConsoleButton } from "./ui";

const PublicInvitationDocument = graphql(`
  query PublicInvitation($token: String!) {
    publicInvitation(token: $token) {
      organizationName
      email
      name
      role
      status
      inviterName
      expiresAt
    }
  }
`);

const AcceptInvitationDocument = graphql(`
  mutation AcceptInvitation($token: String!, $name: String) {
    acceptInvitation(token: $token, name: $name) {
      ok
      organizationId
      userId
      email
      role
    }
  }
`);

type PublicInvitation = NonNullable<PublicInvitationQuery["publicInvitation"]>;

export function InvitePage({ token }: { token: string }) {
  const query = useQuery({
    queryKey: ["invitation", token],
    queryFn: async () => (await gqlFetch(PublicInvitationDocument, { token })).publicInvitation,
    retry: false
  });

  if (query.isLoading) {
    return <InviteShell heading="Invitation"><p className="invite-note">Checking invitation…</p></InviteShell>;
  }
  const invitation = query.data;
  if (!invitation) {
    return (
      <InviteShell heading="Invitation not found">
        <ClosedNote icon={<MailX />} note="This invite link is invalid or no longer exists. Ask your administrator for a new invitation." />
      </InviteShell>
    );
  }
  return <InviteBody invitation={invitation} token={token} />;
}

function InviteBody({ invitation, token }: { invitation: PublicInvitation; token: string }) {
  if (invitation.status === "pending") return <AcceptForm invitation={invitation} token={token} />;
  if (invitation.status === "accepted") {
    return (
      <InviteShell heading="Invitation already accepted">
        <ClosedNote icon={<CheckCircle2 />} note={`This invitation to ${invitation.organizationName} has already been accepted.`} />
        <Link to="/login" className="btn btn-primary invite-login-link">Go to sign in<ArrowRight /></Link>
      </InviteShell>
    );
  }
  if (invitation.status === "revoked") {
    return (
      <InviteShell heading="Invitation revoked">
        <ClosedNote icon={<MailX />} note={`This invitation to ${invitation.organizationName} was revoked. Ask your administrator for a new one.`} />
      </InviteShell>
    );
  }
  return (
    <InviteShell heading="Invitation expired">
      <ClosedNote icon={<MailX />} note={`This invitation to ${invitation.organizationName} expired on ${formatDateTime(invitation.expiresAt)}. Ask your administrator to resend it.`} />
    </InviteShell>
  );
}

function AcceptForm({ invitation, token }: { invitation: PublicInvitation; token: string }) {
  const [name, setName] = useState(invitation.name ?? "");
  const mutation = useMutation({
    mutationFn: async () =>
      (await gqlFetch(AcceptInvitationDocument, { token, name: name.trim() || undefined })).acceptInvitation
  });

  if (mutation.isSuccess) {
    return (
      <InviteShell heading={`Welcome to ${invitation.organizationName}`}>
        <ClosedNote
          icon={<CheckCircle2 />}
          note={`Your membership is active. You joined as ${invitation.role} with ${invitation.email}.`}
        />
        <Link to="/login" className="btn btn-primary invite-login-link">Go to sign in<ArrowRight /></Link>
      </InviteShell>
    );
  }

  return (
    <InviteShell heading={`Join ${invitation.organizationName}`}>
      <div className="invite-meta">
        <Badge variant="accent">{invitation.role}</Badge>
        <span className="invite-note">
          {invitation.inviterName ? `${invitation.inviterName} invited ` : "You were invited as "}
          <strong>{invitation.email}</strong>
        </span>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}>
        <label>
          Your name (optional)
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Lovelace" />
        </label>
        <ConsoleButton type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Accepting" : "Accept invitation"}
          <ArrowRight />
        </ConsoleButton>
        {mutation.error ? <p className="form-error">{mutation.error.message}</p> : null}
      </form>
      <p className="invite-note">Invitation expires {formatDateTime(invitation.expiresAt)}.</p>
    </InviteShell>
  );
}

function InviteShell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="login-page">
      <div className="login-panel">
        <header>
          <p>Prompt Proxy</p>
          <h1>{heading}</h1>
        </header>
        {children}
      </div>
    </section>
  );
}

function ClosedNote({ icon, note }: { icon: ReactNode; note: string }) {
  return (
    <div className="invite-closed">
      {icon}
      <p className="invite-note">{note}</p>
    </div>
  );
}

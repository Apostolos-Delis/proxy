import { redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowRight, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { isAdminRole } from "./access";
import { startLiveUpdates, stopLiveUpdates } from "./liveUpdates";
import { applyGraphQLCacheScope, fetchMe, login, logout, type AuthMe } from "./session";
import { ConsoleButton } from "./ui";

export type RouterContext = {
  queryClient: QueryClient;
};

export async function requireAuth({ context }: { context: RouterContext }) {
  let me: AuthMe;
  try {
    me = await context.queryClient.ensureQueryData({
      queryKey: ["me"],
      queryFn: fetchMe,
      retry: false
    });
  } catch {
    throw redirect({ to: "/login" });
  }
  applyGraphQLCacheScope(me);
  startLiveUpdates(context.queryClient);
  return me;
}

export async function requireAdmin({ context }: { context: RouterContext }) {
  const me = await requireAuth({ context });
  if (!isAdminRole(me.user.role)) {
    throw redirect({ to: "/" });
  }
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/login" });
  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: async (data) => {
      queryClient.setQueryData(["me"], data);
      await navigate({ to: "/" });
    }
  });

  return (
    <section className="login-page">
      <div className="login-panel">
        <HeaderText />
        <form onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <ConsoleButton type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Signing in" : "Sign in"}
            <ArrowRight />
          </ConsoleButton>
          {mutation.error ? <p className="form-error">{mutation.error.message}</p> : null}
        </form>
      </div>
    </section>
  );
}

export function LogoutButton({ icon }: { icon?: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      stopLiveUpdates();
      queryClient.removeQueries({ queryKey: ["me"] });
      await navigate({ to: "/login" });
    }
  });

  return (
    <button className="logout-button" type="button" aria-label="Sign out" title="Sign out" onClick={() => mutation.mutate()}>
      {icon ?? <LogOut />}
      <span className="sidebar-foot-text">Sign out</span>
    </button>
  );
}

function HeaderText() {
  return (
    <header>
      <p>Proxy</p>
      <h1>Admin Login</h1>
    </header>
  );
}

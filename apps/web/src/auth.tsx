import { redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";

import { fetchMe, login, logout } from "./api";

export type RouterContext = {
  queryClient: QueryClient;
};

export async function requireAuth({ context }: { context: RouterContext }) {
  try {
    await context.queryClient.ensureQueryData({
      queryKey: ["me"],
      queryFn: fetchMe,
      retry: false
    });
  } catch {
    throw redirect({ to: "/login" });
  }
}

export function LoginPage() {
  const [email, setEmail] = useState("local@example.com");
  const [password, setPassword] = useState("dev-password");
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
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Signing in" : "Sign in"}
          </button>
          {mutation.error ? <p className="form-error">{mutation.error.message}</p> : null}
        </form>
      </div>
    </section>
  );
}

export function LogoutButton() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["me"] });
      await navigate({ to: "/login" });
    }
  });

  return (
    <button className="logout-button" type="button" onClick={() => mutation.mutate()}>
      <LogOut size={16} />
      Sign out
    </button>
  );
}

function HeaderText() {
  return (
    <header>
      <p>Prompt Proxy</p>
      <h1>Admin Login</h1>
    </header>
  );
}

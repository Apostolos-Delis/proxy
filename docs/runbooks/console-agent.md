# Console Agent Runbook

The console agent is an operations copilot embedded in the admin console. It answers
questions about live proxy state (requests, routing configs, usage, sessions, prompts)
through read capabilities and proposes routing-config changes that humans approve.
Plan: [docs/scopes/console-agent-v1/PLAN.md](../scopes/console-agent-v1/PLAN.md).
Tickets: [docs/scopes/console-agent-v1/TICKETS.md](../scopes/console-agent-v1/TICKETS.md).

## Enabling The Agent Locally

The agent requires database persistence and an API key for its own LLM calls
(it talks to Prompt Proxy itself through `pi-ai`).

```shell
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev:local
```

In dev mode (`ALLOW_DEV_PROXY_TOKEN_FALLBACK=true` or no `DATABASE_URL`), the agent
falls back to `PROMPT_PROXY_TOKEN` for its own calls, so it works out of the box.
Open the web console, sign in as an owner or admin, and use the agent dock (the
console agent button in the shell). Members and viewers receive 403 on every
`/admin/console-agent/*` route.

## Internal API Key Setup (Production)

Outside dev mode the agent needs a dedicated internal key so its traffic is
attributed and excluded from analytics:

1. Set `CONSOLE_AGENT_API_KEY` to a fresh secret at deploy time (environment or
   secret reference, like provider keys). It must differ from `PROMPT_PROXY_TOKEN`.
2. Run `pnpm db:seed`. With `CONSOLE_AGENT_API_KEY` set, seeding creates (idempotently):
   - a `console-agent` routing config with an active v1,
   - an internal API key (`internal = true`) assigned to that config, storing only
     the token hash — the raw token never lands in settings rows or
     `.prompt-proxy/settings.json`.
3. The agent requests explicit route aliases (default `claude-router-hard`), never
   `router-auto`, so its calls skip the classifier entirely.

Internal traffic stays visible in the request logs tagged `internal`, but is
excluded from `/admin/usage` and `/admin/overview` by default.

## Configuration And Limits

Environment variables (also editable in the Console Agent section of the settings
page, persisted to `.prompt-proxy/settings.json`; restart required):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_AGENT_MODEL` | `claude-router-hard` | Model alias the agent requests through the proxy |
| `CONSOLE_AGENT_BASE_URL` | `http://127.0.0.1:$PORT` | Where the agent sends its own LLM calls |
| `CONSOLE_AGENT_API_KEY` | dev fallback to proxy token | Raw internal key token |
| `CONSOLE_AGENT_THINKING_LEVEL` | `medium` | pi thinking level (`off`...`xhigh`) |
| `CONSOLE_AGENT_MAX_TURNS` | `16` | Max model turns per run |
| `CONSOLE_AGENT_MAX_TOOL_CALLS_PER_TURN` | `8` | Max tool calls in a single turn |
| `CONSOLE_AGENT_TIMEOUT_SECONDS` | `120` | Wall-clock limit per run |

Exceeding any limit finalizes the run as `failed` with a `Run stopped: ...` error
in the transcript; persistence stays consistent.

## HTTP Surface

All routes require an owner/admin console session:

- `POST /admin/console-agent/conversations` — create a conversation
- `GET /admin/console-agent/conversations` — list (creator-scoped)
- `GET /admin/console-agent/conversations/:conversationId` — messages, proposals, last run
- `POST /admin/console-agent/conversations/:conversationId/messages` — send a message, starts a run (202)
- `GET /admin/console-agent/runs/:runId/events` — SSE stream (replay via `Last-Event-ID`)
- `POST /admin/console-agent/runs/:runId/cancel` — abort an active run
- `POST /admin/console-agent/proposals/:proposalId/approve`
- `POST /admin/console-agent/proposals/:proposalId/reject`

## Proposal Lifecycle

Write capabilities (`routing_configs.create/create_version/activate_version/archive`,
`api_keys.assign_routing_config`) never execute directly. The agent's call creates a
**proposal** and parks the run `awaiting_approval`:

1. `pending` — the dock renders an approval card from the server-persisted preview
   (never agent prose; this is the prompt-injection boundary). Proposals expire
   after 24 hours and dedupe per run+capability+input.
2. **Approve** — atomically claims the row (`pending -> approved`) and executes the
   held service call inside the same transaction *under the approver's identity*.
   The stored base-state fingerprint is re-checked first; drift (or a 4xx domain
   conflict during execution) resolves the proposal as `stale` with no side effects.
3. **Reject / expire** — no changes are made.

Every transition appends a `console_agent.proposal.*` audit event.

## Troubleshooting Stuck Runs

Run statuses: `running`, then exactly one of `finished`, `failed`, `cancelled`,
`awaiting_approval` (proposal pending), `awaiting_input` (agent asked a question).
Only one `running` run is allowed per conversation (partial unique index).

- **Run appears hung**: check the SSE stream (`GET /admin/console-agent/runs/:runId/events`);
  the wall-clock limit fails runs after `CONSOLE_AGENT_TIMEOUT_SECONDS`.
- **Cancel an active run**: `POST /admin/console-agent/runs/:runId/cancel` (returns
  `{"cancelled": true}` while the agent is live).
- **Run stuck in `running` after a server crash**: the in-memory agent is gone, so
  cancel returns `{"cancelled": false}` and the conversation rejects new messages
  with `run_already_active`. Fail the row manually:

  ```sql
  UPDATE console_agent_runs
  SET status = 'failed', error = 'orphaned by restart', finished_at = now()
  WHERE id = '<run_id>' AND status = 'running';
  ```

- **Proposal approval returns 409/410**: the proposal went `stale` (state drifted
  since preview) or expired — ask the agent to propose again from current state.
- **Agent disabled**: without persistence or (outside dev) `CONSOLE_AGENT_API_KEY`,
  the runtime is not constructed and message posts return 503
  `console_agent_not_configured`.

# Harness Compatibility Matrix

The operations console exposes the harness compatibility matrix at **Operations -> Compatibility**. The same data is served by the admin GraphQL field `harnessCompatibilityMatrix`.

Each row is one harness profile against one provider endpoint dialect.

## Support States

- `native`: the provider endpoint accepts the harness surface without translation.
- `translated`: Prompt Proxy can translate the harness surface to the provider dialect.
- `blocked`: a translator may exist, but the path is unsafe for this profile because of stateful features, WebSocket transport, prior-response state, or unsupported request fields.
- `unsupported`: no compatible provider dialect or translator is available.

## Columns

- `profileId` and `displayName` identify the detected harness profile.
- `surface` and `transport` describe the inbound protocol Prompt Proxy receives.
- `targetDialect` is the provider endpoint dialect being evaluated.
- `nativeSupport` and `translatedSupport` are booleans derived from the shared compatibility engine.
- `unsupportedStatefulFeatures` lists profile features that require native handling on translated paths.
- `reasonCodes` explain blocked or unsupported rows with machine-readable values.
- `testedFixtureCount` is loaded from harness fixture manifests under `apps/proxy/test/fixtures/harnesses` for the exact row path: native fixtures match the profile, translated fixtures match the profile and target dialect.
- `lastSmokeStatus` is nullable until harness smoke status persistence is available.

Support claims should only be expanded when the shared compatibility logic and golden fixtures cover the path.

## Smoke Status

Run local mock-backed harness smoke with:

```bash
pnpm build:runtime
pnpm smoke:harnesses
```

The command prints `harness_path_status` lines for native and translated compatibility paths. It also prints `real_harness_status` lines for installed Codex and Claude Code CLIs. Missing local CLIs are reported as `status=skipped reason=binary_unavailable`; installed CLIs must pass.

To write the JSON status artifact:

```bash
HARNESS_SMOKE_STATUS_PATH=/tmp/harness-smoke-status.json pnpm smoke:harnesses
```

## Adding Support Claims

Before adding a new harness profile or translated dialect pair, add fixture coverage under:

```text
apps/proxy/test/fixtures/harnesses/<profile-id>/<case-id>/
```

Every case needs:

- `manifest.json`
- `inbound-request.json`
- `route-context.json`
- `route-plan-excerpt.json`

Native and translated success cases also need:

- `expected-upstream-request.json`
- `usage.json`
- either `expected-client-response.json` for non-streaming JSON or `expected-client.sse` for streaming

Translated cases must set `targetDialect` in `manifest.json`. Unsupported cases use `mode: "unsupported"` and include `expected-client-response.json` plus the route-plan excerpt that proves the rejection reason.

The harness compatibility test suite fails when a promoted native profile or translated profile path has no required fixture coverage.

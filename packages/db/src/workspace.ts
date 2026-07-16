export const DEFAULT_WORKSPACE_SLUG = "default";

export const DEFAULT_WORKSPACE_NAME = "Default";

// Deterministic id so migrations, seeds, and runtime ensure-flows agree on the
// same default workspace row without a lookup (mirrors the
// other seeded resource ids).
export function defaultWorkspaceId(organizationId: string) {
  return `${organizationId}:workspace:default`;
}

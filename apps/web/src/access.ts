export function isAdminRole(role: string | null | undefined) {
  return role === "owner" || role === "admin";
}

const adminOnlyPathPrefixes = [
  "/api-keys",
  "/billing",
  "/logs",
  "/prompts",
  "/sessions",
  "/settings",
  "/users"
];

export function isAdminPath(path: string) {
  return adminOnlyPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function canAccessPath(path: string, isAdmin: boolean) {
  return isAdmin || !isAdminPath(path);
}

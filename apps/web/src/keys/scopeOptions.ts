export const apiKeyScopeOptions = [
  {
    value: "proxy",
    description: "Send model traffic through the /v1 proxy endpoints."
  },
  {
    value: "harness_identity",
    description: "Trust the user and session identity headers reported by the coding harness."
  },
  {
    value: "admin",
    description: "Reserved for administrative automation."
  }
];

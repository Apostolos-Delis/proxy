export function routeSkipReasonLabel(reason: string) {
  return reason
    .replace(/^target_/, "")
    .replace(/^skipped_/, "")
    .replace(/^unavailable_/, "")
    .replaceAll("_", " ");
}

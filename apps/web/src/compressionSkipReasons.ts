export function compressionSkipReasonLabel(reason: string) {
  if (reason === "cache_hot_zone") return "cache hot zone";
  return reason.replaceAll("_", " ");
}

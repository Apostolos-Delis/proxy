export function uniqueOptions(values: string[]) {
  return [...new Set(values)].filter(Boolean).sort();
}

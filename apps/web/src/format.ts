// Sub-dollar amounts keep extra precision; anything larger reads as normal currency.
export function formatMoney(value: number, maximumFractionDigits?: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maximumFractionDigits ?? (Math.abs(value) < 1 ? 4 : 2)
  }).format(value);
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

export function formatCompactMoney(value: number) {
  if (value !== 0 && Math.abs(value) < 1) return formatMoney(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

export function formatInteger(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function compactId(value: string, size = 10) {
  if (value.length <= size * 2 + 1) return value;
  return `${value.slice(0, size)}...${value.slice(-size)}`;
}

export function dominantKey(counts: Record<string, number>) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
}

export function compactCounts(counts: Record<string, number>) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

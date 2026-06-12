import { EFFORT_SCALE, editorRouteOrder } from "../routingConfigEditor";

const TIER_ORDER: readonly string[] = editorRouteOrder;

const EFFORT_ORDER: readonly string[] = EFFORT_SCALE;

// Effort-style synonyms seen in request data map onto the tier scale.
const TIER_ALIASES: Record<string, string> = {
  low: "fast",
  minimal: "fast",
  medium: "balanced",
  auto: "balanced",
  high: "hard",
  xhigh: "deep",
  max: "deep"
};

// Unknown values rank 0: every segment stays unlit while the label still
// shows the raw string.
function tierOrdinal(route: string) {
  const value = route.toLowerCase();
  return TIER_ORDER.indexOf(TIER_ALIASES[value] ?? value) + 1;
}

function effortOrdinal(effort: string) {
  return EFFORT_ORDER.indexOf(effort.toLowerCase()) + 1;
}

// Tier as an ordinal signal: stepped bars in a single hue instead of one
// color per tier, so cards read calm at a glance.
export function TierGauge({ route, dim = false }: { route: string; dim?: boolean }) {
  const ordinal = tierOrdinal(route);
  return (
    <span className={`tier-gauge${dim ? " dim" : ""}`}>
      <span className="tier-gauge-bars" aria-hidden>
        {TIER_ORDER.map((_, index) => (
          <i key={index} className={index < ordinal ? "on" : ""} />
        ))}
      </span>
      <span className="tier-gauge-label">{route}</span>
    </span>
  );
}

// Effort as an ordinal signal: short line segments (not dots) filled up to
// the level. Empty segments with a "default" label mean provider default.
export function EffortMeter({ effort, dim = false, label = true }: {
  effort: string | null | undefined;
  dim?: boolean;
  label?: boolean;
}) {
  const value = effort ?? "";
  const ordinal = value ? effortOrdinal(value) : 0;
  return (
    <span className={`effort-meter${dim ? " dim" : ""}`} title={value ? `effort ${value}` : "default effort"}>
      <span className="effort-meter-lines" aria-hidden>
        {EFFORT_ORDER.map((_, index) => (
          <i key={index} className={ordinal > 0 && index < ordinal ? "on" : ""} />
        ))}
      </span>
      {label ? <span className="effort-meter-label">{value || "default"}</span> : null}
    </span>
  );
}

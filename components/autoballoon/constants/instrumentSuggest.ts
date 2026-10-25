/** Automatic instrument suggestion for inspection report rows (defaults in instrument_rules.json). */
import defaults from "./instrument_rules.json";

export type InstrumentRule = {
  name: string;
  resolution_mm: number;
  min_mm: number | null;
  max_mm: number | null;
  features: string[];
  cost_rank: number;
  /** false = never auto-selected (Instrument Settings). */
  enabled?: boolean;
};

export type InstrumentRules = {
  accuracy_ratio: number;
  fallback_accuracy_ratio: number | null;
  default_band_mm: number;
  instruments: InstrumentRule[];
  feature_types: Record<string, string[]>;
  gdt_types: string[];
  angle_types: string[];
};

/** Saved (editable) part of the rules — what the settings API stores. */
export type EditableInstrumentRules = Pick<InstrumentRules, "accuracy_ratio" | "fallback_accuracy_ratio" | "instruments">;

export const DEFAULT_RULES: InstrumentRules = {
  accuracy_ratio: defaults.accuracy_ratio,
  fallback_accuracy_ratio: defaults.fallback_accuracy_ratio,
  default_band_mm: defaults.default_band_mm,
  instruments: (defaults.instruments as InstrumentRule[]).map((i) => ({ ...i, enabled: true })),
  feature_types: defaults.feature_types as Record<string, string[]>,
  gdt_types: defaults.gdt_types,
  angle_types: defaults.angle_types,
};

/** Defaults overlaid with saved settings (null/undefined = defaults). */
export function mergeRules(saved?: Partial<EditableInstrumentRules> | null): InstrumentRules {
  if (!saved) return DEFAULT_RULES;
  return {
    ...DEFAULT_RULES,
    accuracy_ratio: saved.accuracy_ratio ?? DEFAULT_RULES.accuracy_ratio,
    fallback_accuracy_ratio:
      saved.fallback_accuracy_ratio === undefined ? DEFAULT_RULES.fallback_accuracy_ratio : saved.fallback_accuracy_ratio,
    instruments: saved.instruments?.length ? saved.instruments : DEFAULT_RULES.instruments,
  };
}

let activeRules: InstrumentRules = DEFAULT_RULES;

/** Rules used by suggestInstrument() when none are passed (set from Instrument Settings). */
export function setActiveRules(r: InstrumentRules): void {
  activeRules = r;
}

export function getActiveRules(): InstrumentRules {
  return activeRules;
}

export type SuggestInput = {
  nominal: string;
  tol_low: string;
  tol_high: string;
  unit?: string;
  /** Detected feature type (see featureTypeFor); "" = unknown. */
  featureType?: string;
};

export type InstrumentSuggestion = {
  /** "" when nothing qualifies — row must be reviewed. */
  instrument: string;
  /** Short line shown under the dropdown. */
  summary: string;
  /** Full explanation for the tooltip. */
  reason: string;
  featureType: string;
  bandMm: number | null;
};

/** Unit → factor to millimetres. Angles are not converted. */
const TO_MM: Record<string, number> = { mm: 1, "µm": 0.001, um: 0.001, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

function num(s: string | undefined): number | null {
  const m = String(s ?? "").replace(",", ".").match(/[-+]?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
}

function fmt(v: number): string {
  return v >= 1 ? String(Number(v.toFixed(2))) : String(Number(v.toPrecision(2)));
}

/** Guess the feature type from the ballooned text + detector category/pattern. */
export function featureTypeFor(b?: { text?: string; category?: string; pattern?: string } | null): string {
  if (!b) return "";
  const text = String(b.text || "");
  const cat = String(b.category || "").toLowerCase();
  const pat = String(b.pattern || "").toLowerCase();
  if (/⌖/.test(text)) return "position";
  if (/[⌓⌒]/.test(text)) return "profile";
  if (/[↗⌰]/.test(text)) return "runout";
  if (/⏥/.test(text)) return "flatness";
  if (/∥/.test(text)) return "parallelism";
  if (/⊥/.test(text)) return "perpendicularity";
  if (/◎/.test(text)) return "concentricity";
  if (/⌭/.test(text)) return "cylindricity";
  if (cat === "gdt") return "gdt";
  if (cat === "thread" || /thread/.test(pat) || /^\s*M\d/i.test(text)) return "thread";
  if (cat === "surface" || /surface|roughness/.test(pat) || /\bR[az]\b/i.test(text)) return "surface_finish";
  if (cat === "chamfer" || /chamfer/.test(pat)) return "chamfer";
  if (cat === "angle" || /angle/.test(pat) || /°/.test(text)) return "angle";
  if (cat === "radius" || /radius/.test(pat) || /^\s*S?R\s*\d/i.test(text)) return "radius";
  if (/thickness|material_thk/.test(pat)) return "thickness";
  if (pat === "depth" || /\bDEEP\b|\bDEPTH\b/i.test(text)) return "depth";
  const isDia = cat === "diameter" || /dia|bush|pcd|od_id|hole/.test(pat) || /[Ø⌀]|\bDIA\b/i.test(text);
  if (isDia) {
    if (/hole|spotface/.test(pat) || /\bTHRU\b|\bHOLES?\b|\bID\b|\d\s*[A-H]\d{1,2}\b/.test(text)) return "internal_diameter";
    if (/\bOD\b|\d\s*[a-h]\d{1,2}\b/.test(text)) return "external_diameter";
    return "diameter";
  }
  if (/\bHEIGHT\b|\bHT\b/i.test(text)) return "height";
  if (cat === "linear" || cat === "tolerance" || /linear|tol_/.test(pat)) return "length";
  return "";
}

/** Pick the simplest adequate instrument (rank, then finer resolution). */
export function suggestInstrument(input: SuggestInput, rules: InstrumentRules = activeRules): InstrumentSuggestion {
  const featureType = input.featureType || "";
  const unit = (input.unit || "mm").trim();
  const isAngle = rules.angle_types.includes(featureType) || unit === "°";
  const isGdt = rules.gdt_types.includes(featureType);
  const factor = isAngle ? 1 : (TO_MM[unit] ?? 1);
  const steps: string[] = [];

  // 1. Tolerance band
  const lo = num(input.tol_low);
  const hi = num(input.tol_high);
  const nominal = num(input.nominal);
  let band: number | null;
  let bandNote: string;
  if (lo !== null || hi !== null) {
    band = Math.abs((hi ?? 0) - (lo ?? 0)) * factor;
    bandNote = `Band ${fmt(band)}${isAngle ? "°" : " mm"}`;
  } else if (isGdt && nominal !== null) {
    band = Math.abs(nominal) * factor; // GD&T: the value is the tolerance zone
    bandNote = `Tol zone ${fmt(band)} mm`;
  } else {
    band = rules.default_band_mm;
    bandNote = `No tol → general band ${fmt(band)} mm assumed`;
  }
  steps.push(bandNote);
  const size = isGdt || isAngle || nominal === null ? null : Math.abs(nominal) * factor;

  // 2. Feature type
  const tags = featureType ? rules.feature_types[featureType] : undefined;
  if (tags && tags.length === 0) {
    const reason = `${featureType.replace("_", " ")}: no instrument in the rule table suits this feature`;
    return { instrument: "", summary: "No suitable instrument — review", reason, featureType, bandMm: band };
  }
  const enabled = rules.instruments.filter((i) => i.enabled !== false);
  let pool = enabled;
  if (tags) {
    pool = enabled.filter((i) => i.features.includes("*") || i.features.some((f) => tags.includes(f)));
    steps.unshift(`Type: ${featureType.replace("_", " ")}`);
  } else {
    steps.unshift("Type unknown → tolerance + size only");
  }

  // 4. Range covers the nominal size (not checked for angles / GD&T zones)
  if (size !== null) {
    pool = pool.filter((i) => (i.min_mm === null || size >= i.min_mm) && (i.max_mm === null || size <= i.max_mm));
    steps.push(`size ${fmt(size)} mm`);
  }

  // 3. Resolution ≤ band ÷ ratio (angles: resolution is in mm, so skip)
  const pick = (ratio: number) => {
    const need = (band ?? 0) / ratio;
    const ok = isAngle ? pool : pool.filter((i) => i.resolution_mm <= need + 1e-12);
    // 5. Lowest cost rank, tie → finer resolution
    return [...ok].sort((a, b) => a.cost_rank - b.cost_rank || a.resolution_mm - b.resolution_mm)[0];
  };
  let ratio = rules.accuracy_ratio;
  let best = pick(ratio);
  if (!best && rules.fallback_accuracy_ratio && !isAngle) {
    ratio = rules.fallback_accuracy_ratio;
    best = pick(ratio);
  }
  const needNote = isAngle ? "angle (resolution not compared)" : `needs ≤${fmt((band ?? 0) / ratio)} mm (${ratio}:1)`;
  steps.push(needNote);

  if (!best) {
    const reason = `${steps.join(" · ")} → nothing in the rule table qualifies`;
    return { instrument: "", summary: "No suitable instrument — review", reason, featureType, bandMm: band };
  }
  const reason = `${steps.join(" · ")} → ${best.name} (${best.resolution_mm} mm, rank ${best.cost_rank})`;
  const summary = `${bandNote} → ${needNote} → ${best.name}`;
  return { instrument: best.name, summary, reason, featureType, bandMm: band };
}

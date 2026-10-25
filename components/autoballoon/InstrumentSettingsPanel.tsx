import { useState } from "react";
import {
  DEFAULT_RULES,
  type EditableInstrumentRules,
  type InstrumentRules,
} from "./constants/instrumentSuggest";

type DraftRow = {
  name: string;
  resolution: string;
  min: string;
  max: string;
  features: string;
  rank: string;
  enabled: boolean;
};

type Draft = { ratio: string; fallback: string; rows: DraftRow[] };

function toDraft(r: InstrumentRules): Draft {
  return {
    ratio: String(r.accuracy_ratio),
    fallback: r.fallback_accuracy_ratio == null ? "" : String(r.fallback_accuracy_ratio),
    rows: r.instruments.map((i) => ({
      name: i.name,
      resolution: String(i.resolution_mm),
      min: i.min_mm == null ? "" : String(i.min_mm),
      max: i.max_mm == null ? "" : String(i.max_mm),
      features: i.features.join(", "),
      rank: String(i.cost_rank),
      enabled: i.enabled !== false,
    })),
  };
}

const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));

/** Field errors keyed "ratio" | "fallback" | "<row>.<field>". */
function validate(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!isNum(d.ratio) || Number(d.ratio) <= 0) e.ratio = "Must be > 0";
  if (d.fallback.trim() && (!isNum(d.fallback) || Number(d.fallback) <= 0)) e.fallback = "Must be > 0 or blank";
  d.rows.forEach((r, i) => {
    if (!isNum(r.resolution) || Number(r.resolution) <= 0) e[`${i}.resolution`] = "Must be > 0";
    if (r.min.trim() && (!isNum(r.min) || Number(r.min) < 0)) e[`${i}.min`] = "Must be ≥ 0";
    if (r.max.trim()) {
      const min = r.min.trim() && isNum(r.min) ? Number(r.min) : 0;
      if (!isNum(r.max) || Number(r.max) <= min) e[`${i}.max`] = "Must be > min";
    }
    if (!/^\d+$/.test(r.rank.trim()) || Number(r.rank) < 1) e[`${i}.rank`] = "Positive whole number";
    if (!r.features.trim()) e[`${i}.features`] = "At least one tag (or *)";
  });
  return e;
}

function fromDraft(d: Draft): EditableInstrumentRules {
  return {
    accuracy_ratio: Number(d.ratio),
    fallback_accuracy_ratio: d.fallback.trim() ? Number(d.fallback) : null,
    instruments: d.rows.map((r) => ({
      name: r.name,
      resolution_mm: Number(r.resolution),
      min_mm: r.min.trim() ? Number(r.min) : null,
      max_mm: r.max.trim() ? Number(r.max) : null,
      features: r.features.split(",").map((f) => f.trim()).filter(Boolean),
      cost_rank: Number(r.rank),
      enabled: r.enabled,
    })),
  };
}

export default function InstrumentSettingsPanel({
  rules,
  canEdit,
  autoCounts,
  onSave,
  onClose,
}: {
  rules: InstrumentRules;
  canEdit: boolean;
  /** Rows currently auto-selected in this report, per instrument. */
  autoCounts: Record<string, number>;
  onSave: (rules: EditableInstrumentRules) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(rules));
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const errors = validate(draft);
  const hasErrors = Object.keys(errors).length > 0;
  const totalAuto = Object.values(autoCounts).reduce((a, b) => a + b, 0);

  const setRow = (i: number, patch: Partial<DraftRow>) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const save = async () => {
    if (hasErrors || !canEdit) return;
    setSaving(true);
    setSaveErr("");
    try {
      await onSave(fromDraft(draft));
    } catch (e: any) {
      setSaveErr(e?.message || "Could not save instrument rules");
      setSaving(false);
    }
  };

  const cell = (i: number, field: keyof DraftRow, placeholder = "") => {
    const err = errors[`${i}.${field}`];
    return (
      <td>
        <input
          className={`instr-settings-input${err ? " instr-settings-input-bad" : ""}`}
          value={draft.rows[i][field] as string}
          placeholder={placeholder}
          disabled={!canEdit}
          onChange={(e) => setRow(i, { [field]: e.target.value } as Partial<DraftRow>)}
        />
        {err && <div className="instr-settings-err">{err}</div>}
      </td>
    );
  };

  return (
    <div className="instr-settings-backdrop" onClick={onClose}>
      <div className="instr-settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Instrument settings">
        <div className="instr-settings-head">
          <div>
            <h2>Instrument Settings</h2>
            <p className="muted">
              Auto-selection rules. Saving re-runs auto-selection on every auto-selected row of this report — manual picks are never changed.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {!canEdit && (
          <div className="instr-settings-readonly">Read-only — only a super admin can change instrument rules.</div>
        )}

        <div className="instr-settings-ratios">
          <label>
            Accuracy ratio
            <span className="instr-settings-ratio">
              <input
                className={`instr-settings-input${errors.ratio ? " instr-settings-input-bad" : ""}`}
                value={draft.ratio}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, ratio: e.target.value }))}
              />
              : 1
            </span>
            {errors.ratio && <span className="instr-settings-err">{errors.ratio}</span>}
          </label>
          <label title="Used only when nothing qualifies at the accuracy ratio. Blank = no retry.">
            Fallback ratio
            <span className="instr-settings-ratio">
              <input
                className={`instr-settings-input${errors.fallback ? " instr-settings-input-bad" : ""}`}
                value={draft.fallback}
                placeholder="none"
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, fallback: e.target.value }))}
              />
              : 1
            </span>
            {errors.fallback && <span className="instr-settings-err">{errors.fallback}</span>}
          </label>
        </div>

        <div className="instr-settings-wrap">
          <table className="instr-settings-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Resolution (mm)</th>
                <th>Min range (mm)</th>
                <th>Max range (mm)</th>
                <th>Feature types</th>
                <th>Priority (cost rank)</th>
                <th>Enabled</th>
                <th>Auto rows</th>
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((r, i) => (
                <tr key={r.name} className={r.enabled ? "" : "instr-settings-off"}>
                  <td className="instr-settings-name">{r.name}</td>
                  {cell(i, "resolution")}
                  {cell(i, "min", "0")}
                  {cell(i, "max", "any")}
                  {cell(i, "features")}
                  {cell(i, "rank")}
                  <td className="instr-settings-center">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={!canEdit}
                      onChange={(e) => setRow(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td className="instr-settings-center">{autoCounts[r.name] || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="muted instr-settings-note">
          Rows auto-selected per instrument in this report: <strong>{totalAuto}</strong> in total (column "Auto rows"). Feature
          types are comma-separated tags (e.g. external, internal, length; <code>*</code> = any feature).
        </p>

        {saveErr && <div className="error mb">{saveErr}</div>}
        {hasErrors && canEdit && <div className="instr-settings-err">Fix the highlighted fields to enable Save.</div>}

        <div className="instr-settings-actions">
          <button
            className="btn btn-ghost btn-sm"
            disabled={!canEdit || saving}
            onClick={() => setDraft(toDraft(DEFAULT_RULES))}
            title="Fill the form with the built-in defaults (press Save to apply)"
          >
            Reset to defaults
          </button>
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              style={{ width: "auto" }}
              disabled={!canEdit || hasErrors || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

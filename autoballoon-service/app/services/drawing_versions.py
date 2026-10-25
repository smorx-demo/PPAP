"""
Persistent balloon numbering + change detection across uploads of the same drawing.

Wraps the existing ballooning output (never alters detection):
  1. Identify the drawing (title-block part number, else file name).
  2. First upload  → deterministic numbering (sheet, top→bottom, left→right) = Version 1.
  3. Later uploads → match features to the saved map and reuse their numbers.
     Changed / New features get a dark-blue box; Removed ones go in the summary.
  4. Any change → next version. Identical upload → same version, no new record.

Storage: Postgres tables drawing_masters / drawing_versions when connected,
otherwise backend/data/drawing_versions.json.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path

import fitz

from app.core import database as dbmod

ROOT = Path(__file__).resolve().parents[2]  # backend/
JSON_PATH = ROOT / "data" / "drawing_versions.json"

# Normalised (0..1 of page width/height) matching window between uploads.
MATCH_WINDOW = 0.025
# Features whose centres are within this vertical band count as the same row.
ROW_BAND = 0.015

HIGHLIGHT_COLOR = (0.043, 0.18, 0.42)  # dark blue #0B2E6B — balloons are red
# Changed / New balloons: bold dark-green rim + leader, fluorescent orange fill, bold black number
CHANGED_BALLOON_RIM = (0.0, 0.39, 0.0)  # dark green #006400
CHANGED_BALLOON_FILL = (1.0, 0.37, 0.08)  # fluorescent orange #FF5F15
CHANGED_BALLOON_TEXT = (0.0, 0.0, 0.0)
CHANGED_BALLOON_RIM_WIDTH = 2.6
CHANGED_BALLOON_LEADER_WIDTH = 1.6
HIGHLIGHT_WIDTH = 2.5
HIGHLIGHT_PAD = 3.0

_lock = threading.Lock()
_tables_ready = False


# ---------------------------------------------------------------- identity


def _norm_token(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", (s or "").strip().upper())
    return re.sub(r"_+", "_", s).strip("_.")


def drawing_key_for(part_number: str, file_name: str) -> tuple[str, str]:
    """Return (key, source) where source is 'part_number' or 'file_name'."""
    pn = _norm_token(part_number)
    if pn:
        return f"PN-{pn}", "part_number"
    stem = _norm_token(Path(file_name or "").stem)
    return f"FILE-{stem or 'UNNAMED'}", "file_name"


def drawing_fingerprint(pdf_path: Path) -> str:
    """Hash of what the drawing looks like (low-res render), not of PDF bytes.

    Re-saved/merged PDFs get new IDs/timestamps, so byte hashes differ for the
    same drawing. OCR text layers are invisible, so OCR does not change this.
    """
    h = hashlib.sha256()
    doc = fitz.open(str(pdf_path))
    try:
        for page in doc:
            pix = page.get_pixmap(dpi=40, colorspace=fitz.csGRAY, alpha=False)
            h.update(f"{pix.width}x{pix.height}".encode())
            h.update(pix.samples)
    finally:
        doc.close()
    return h.hexdigest()


def page_sizes(pdf_path: Path) -> dict[int, tuple[float, float]]:
    """1-based page → (width, height) in unrotated draw space (balloon coords)."""
    doc = fitz.open(str(pdf_path))
    try:
        out = {}
        for i, page in enumerate(doc, start=1):
            mb = fitz.Rect(page.mediabox)
            out[i] = (float(mb.width) or 1.0, float(mb.height) or 1.0)
        return out
    finally:
        doc.close()


# ---------------------------------------------------------------- map entries


def _centre(b: dict) -> tuple[float, float]:
    return (
        float(b.get("x") or 0) + float(b.get("width") or 0) / 2.0,
        float(b.get("y") or 0) + float(b.get("height") or 0) / 2.0,
    )


def build_entries(
    balloons: list[dict],
    rows: list[dict],
    sizes: dict[int, tuple[float, float]],
) -> list[dict]:
    """Balloon dicts + report rows → map entries (keeps full balloon geometry)."""
    row_by_no = {int(r.get("balloon") or 0): r for r in rows or []}
    out = []
    for b in balloons:
        page = int(b.get("page") or 1)
        pw, ph = sizes.get(page, (1.0, 1.0))
        cx, cy = _centre(b)
        r = row_by_no.get(int(b.get("balloon") or 0), {})
        out.append({
            "balloon": int(b.get("balloon") or 0),
            "page": page,
            "nx": round(cx / pw, 5),
            "ny": round(cy / ph, 5),
            "type": str(b.get("category") or ""),
            "view": str(r.get("reference") or f"P{page}"),
            "text": str(b.get("text") or ""),
            "nominal": str(r.get("nominal") or ""),
            "tol_low": str(r.get("tol_low") or ""),
            "tol_high": str(r.get("tol_high") or ""),
            "unit": str(r.get("unit") or "mm"),
            "geom": {k: b.get(k) for k in (
                "page", "text", "x", "y", "width", "height", "category", "pattern",
                "bx", "by", "tx", "ty", "arrow_size",
            )},
        })
    return out


def deterministic_order(entries: list[dict]) -> list[dict]:
    """Sheet by sheet, top→bottom (row bands), then left→right."""
    out: list[dict] = []
    for page in sorted({e["page"] for e in entries}):
        items = sorted((e for e in entries if e["page"] == page), key=lambda e: (e["ny"], e["nx"]))
        rows: list[list[dict]] = []
        for e in items:
            if rows and e["ny"] - rows[-1][0]["ny"] <= ROW_BAND:
                rows[-1].append(e)
            else:
                rows.append([e])
        for row in rows:
            out.extend(sorted(row, key=lambda e: (e["nx"], e["ny"])))
    return out


def _num(s: str) -> str:
    """Compare values numerically when possible (10.0 == 10)."""
    s = (s or "").strip().replace(",", ".")
    try:
        return repr(round(float(s), 6))
    except ValueError:
        return re.sub(r"\s+", "", s).upper()


def _values_changed(old: dict, new: dict) -> bool:
    return any(_num(old.get(k, "")) != _num(new.get(k, "")) for k in ("nominal", "tol_low", "tol_high"))


def _value_label(e: dict) -> str:
    v = e.get("nominal") or e.get("text") or ""
    lo, hi = e.get("tol_low") or "", e.get("tol_high") or ""
    if lo or hi:
        v = f"{v} ({lo or '0'} / +{hi.lstrip('+') or '0'})"
    return v


def match_to_map(
    detected: list[dict],
    saved: list[dict],
    max_ever: int,
) -> tuple[list[dict], list[dict], int]:
    """Assign saved numbers to detected features. Returns (entries, changes, new_max)."""
    pairs = []
    for di, d in enumerate(detected):
        for si, s in enumerate(saved):
            if d["page"] != s["page"] or d["type"] != s["type"]:
                continue
            dist = ((d["nx"] - s["nx"]) ** 2 + (d["ny"] - s["ny"]) ** 2) ** 0.5
            if dist <= MATCH_WINDOW:
                # Same view (grid zone) wins ties against a neighbouring zone.
                pairs.append((dist + (0 if d["view"] == s["view"] else MATCH_WINDOW), di, si))
    pairs.sort()
    used_d: set[int] = set()
    used_s: set[int] = set()
    out: list[dict] = []
    changes: list[dict] = []
    for _, di, si in pairs:
        if di in used_d or si in used_s:
            continue
        used_d.add(di)
        used_s.add(si)
        d, s = detected[di], saved[si]
        e = dict(d, balloon=s["balloon"], status="unchanged")
        if _values_changed(s, d):
            e["status"] = "changed"
            changes.append({
                "balloon": s["balloon"], "status": "Changed", "page": d["page"],
                "old_value": _value_label(s), "new_value": _value_label(d),
            })
        out.append(e)

    new_max = max_ever
    fresh = [d for i, d in enumerate(detected) if i not in used_d]
    for d in deterministic_order(fresh):
        new_max += 1
        out.append(dict(d, balloon=new_max, status="new"))
        changes.append({
            "balloon": new_max, "status": "New", "page": d["page"],
            "old_value": "", "new_value": _value_label(d),
        })
    for i, s in enumerate(saved):
        if i not in used_s:
            changes.append({
                "balloon": s["balloon"], "status": "Removed", "page": s["page"],
                "old_value": _value_label(s), "new_value": "",
            })
    out.sort(key=lambda e: e["balloon"])
    changes.sort(key=lambda c: (c["balloon"], c["status"]))
    return out, changes, new_max


def entries_to_balloons(entries: list[dict]) -> list[dict]:
    out = []
    for e in entries:
        b = dict(e.get("geom") or {})
        b["balloon"] = int(e["balloon"])
        b["page"] = int(e["page"])
        out.append(b)
    return out


def strip_status(entries: list[dict]) -> list[dict]:
    return [{k: v for k, v in e.items() if k != "status"} for e in entries]


# ---------------------------------------------------------------- output overlay


def _to_chars(balloons: list[dict]):
    from app.services.autoballoon_engine import Characteristic

    def f(v):
        return float(v) if v is not None else None

    return [
        Characteristic(
            balloon=int(b["balloon"]), page=int(b.get("page") or 1), text=str(b.get("text") or ""),
            x=float(b.get("x") or 0), y=float(b.get("y") or 0),
            width=float(b.get("width") or 20), height=float(b.get("height") or 12),
            category=str(b.get("category") or ""), pattern=str(b.get("pattern") or ""), family="",
            bx=f(b.get("bx")), by=f(b.get("by")), tx=f(b.get("tx")), ty=f(b.get("ty")),
            arrow_size=f(b.get("arrow_size")),
        )
        for b in balloons
    ]


def _draw_changed_balloons(doc: fitz.Document, balloons: list[dict]) -> None:
    """Bold green/orange balloons with black numbers, same geometry as draw_balloons."""
    import math

    from app.services.autoballoon_engine import _arrowhead, _balloon_radius

    for page in doc:
        items = [b for b in balloons if int(b.get("page") or 1) == page.number + 1]
        if not items:
            continue
        shape = page.new_shape()
        for b in items:
            label = str(int(b["balloon"]))
            r = _balloon_radius(page, label)
            cx, cy = float(b["bx"]), float(b["by"])
            tx = float(b["tx"]) if b.get("tx") is not None else float(b["x"]) + float(b.get("width") or 20) / 2
            ty = float(b["ty"]) if b.get("ty") is not None else float(b["y"]) + float(b.get("height") or 12) / 2
            arrow_scale = float(b["arrow_size"]) if b.get("arrow_size") is not None else 1.0
            dx, dy = tx - cx, ty - cy
            dist = math.hypot(dx, dy) or 1.0
            ux, uy = dx / dist, dy / dist
            tip_gap = max(2.0, min(float(b.get("width") or 20), float(b.get("height") or 12)) * 0.15 + 1.5)
            start = fitz.Point(cx + ux * (r + 0.4), cy + uy * (r + 0.4))
            tip = fitz.Point(tx - ux * tip_gap, ty - uy * tip_gap)

            shape.draw_line(start, tip)
            shape.finish(color=CHANGED_BALLOON_RIM, width=CHANGED_BALLOON_LEADER_WIDTH)
            tip_p, left, right = _arrowhead(tip, start, size=max(2.2, r * 0.38 * arrow_scale))
            shape.draw_polyline([left, tip_p, right])
            shape.finish(color=CHANGED_BALLOON_RIM, fill=CHANGED_BALLOON_RIM, width=0.4, closePath=True)

            shape.draw_circle(fitz.Point(cx, cy), r)
            shape.finish(color=CHANGED_BALLOON_RIM, fill=CHANGED_BALLOON_FILL, width=CHANGED_BALLOON_RIM_WIDTH)

            fontsize = r * (0.95 if len(label) >= 4 else 1.05 if len(label) == 3 else 1.25)
            tw = fitz.get_text_length(label, fontname="hebo", fontsize=fontsize)
            shape.insert_text(
                fitz.Point(cx - tw / 2, cy + fontsize * 0.36),
                label,
                fontsize=fontsize,
                fontname="hebo",  # Helvetica-Bold
                color=CHANGED_BALLOON_TEXT,
            )
        shape.commit()


def draw_highlighted_balloons(src_pdf: Path, out_pdf: Path, balloons: list[dict], highlight: set[int]) -> None:
    """Redraw the output: unchanged balloons red (as today), Changed / New balloons
    bold dark-green rim, fluorescent-orange fill and bold black number.

    Balloons must already carry bx/by (placed), so positions match the normal output.
    The source drawing is only read; the result goes to out_pdf.
    """
    from app.services.autoballoon_engine import draw_balloons

    normal = [b for b in balloons if int(b["balloon"]) not in highlight]
    marked = [b for b in balloons if int(b["balloon"]) in highlight]
    src = fitz.open(str(src_pdf))
    try:
        out = draw_balloons(src, _to_chars(normal))
        try:
            _draw_changed_balloons(out, marked)
            data = out.tobytes(deflate=True, garbage=3)
        finally:
            out.close()
    finally:
        src.close()
    out_pdf.write_bytes(data)


def highlight_features(balloons: list[dict], numbers: set[int], changes: list[dict]) -> list[dict]:
    """Remember highlighted features by their dimension box, so renumbering keeps the highlight."""
    status = {int(c["balloon"]): c["status"] for c in changes}
    return [
        {
            "balloon": int(b["balloon"]),
            "status": status.get(int(b["balloon"]), ""),
            "page": int(b.get("page") or 1),
            "x": float(b.get("x") or 0),
            "y": float(b.get("y") or 0),
            "width": float(b.get("width") or 0),
            "height": float(b.get("height") or 0),
        }
        for b in balloons
        if int(b["balloon"]) in numbers
    ]


def current_highlight_numbers(features: list[dict], balloons: list[dict]) -> dict[int, int]:
    """Map original highlighted balloon no. → current balloon no. on the same dimension."""
    out: dict[int, int] = {}
    used: set[int] = set()
    for f in features:
        fx, fy = _centre(f)
        tol = max(3.0, 0.6 * min(float(f.get("height") or 12), float(f.get("width") or 12)))
        best, best_d = None, tol
        for b in balloons:
            n = int(b.get("balloon") or 0)
            if n in used or int(b.get("page") or 1) != int(f["page"]):
                continue
            bx, by = _centre(b)
            d = ((bx - fx) ** 2 + (by - fy) ** 2) ** 0.5
            if d <= best_d:
                best, best_d = n, d
        if best is not None:
            used.add(best)
            out[int(f["balloon"])] = best
    return out


def version_report_info(meta: dict) -> dict:
    """For the inspection report: {"version": N, "rows": [current balloon numbers of Changed / New features]}."""
    try:
        info = meta.get("drawing_version") or {}
        if not info.get("version") or info.get("pending"):
            return {}
        features = info.get("highlight_features")
        if features is None:
            numbers = [int(n) for n in info.get("highlighted") or []]
        else:
            numbers = list(current_highlight_numbers(features, meta.get("balloons") or []).values())
        return {"version": int(info["version"]), "rows": sorted(numbers)}
    except Exception:
        return {}


def apply_version_overlay_for_job(job_dir: Path, src_pdf: Path, out_pdf: Path, balloons: list[dict]) -> None:
    """Re-apply the version highlight after any redraw of the ballooned PDF (edits, renumbering).

    Reads the job's drawing_version; highlights follow the dimension, not the balloon number.
    Never raises — a failure leaves the normal ballooned PDF as it is.
    """
    try:
        meta_path = job_dir / "meta.json"
        if not meta_path.exists():
            return
        info = (json.loads(meta_path.read_text(encoding="utf-8")) or {}).get("drawing_version") or {}
        if not info.get("version") or info.get("pending"):
            return
        features = info.get("highlight_features")
        if features is None:  # jobs versioned before features were stored
            numbers = {int(n) for n in info.get("highlighted") or []}
        else:
            numbers = set(current_highlight_numbers(features, balloons).values())
        if numbers:
            draw_highlighted_balloons(src_pdf, out_pdf, balloons, numbers)
        draw_version_overlay(out_pdf, balloons, numbers, int(info["version"]))
    except Exception:
        pass


def draw_version_overlay(pdf_path: Path, balloons: list[dict], highlight: set[int], version: int) -> None:
    """Dark-blue boxes on Changed/New features + 'Version N' stamp. Output PDF only."""
    doc = fitz.open(str(pdf_path))
    try:
        for page in doc:
            shape = page.new_shape()
            for b in balloons:
                if int(b.get("page") or 1) != page.number + 1 or int(b["balloon"]) not in highlight:
                    continue
                x, y = float(b.get("x") or 0), float(b.get("y") or 0)
                w, h = float(b.get("width") or 20), float(b.get("height") or 12)
                shape.draw_rect(fitz.Rect(x - HIGHLIGHT_PAD, y - HIGHLIGHT_PAD, x + w + HIGHLIGHT_PAD, y + h + HIGHLIGHT_PAD))
                shape.finish(color=HIGHLIGHT_COLOR, width=HIGHLIGHT_WIDTH)
            shape.commit()
            _stamp_version(page, version)
        data = doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()
    pdf_path.write_bytes(data)


def _stamp_version(page: fitz.Page, version: int) -> None:
    """'Version N' in the visual top-right corner, upright on rotated sheets."""
    label = f"Version {version}"
    view = page.rect  # rotated (as-seen) space
    fs = max(10.0, min(view.width, view.height) * 0.018)
    tw = fitz.get_text_length(label, fontname="hebo", fontsize=fs)
    margin = fs * 1.2
    pad = fs * 0.5
    box_v = fitz.Rect(view.x1 - margin - tw - 2 * pad, view.y0 + margin, view.x1 - margin, view.y0 + margin + fs * 1.5)
    m = page.derotation_matrix
    box = fitz.Rect(box_v.tl * m, box_v.br * m)
    box.normalize()
    page.draw_rect(box, color=HIGHLIGHT_COLOR, fill=(1, 1, 1), width=1.5)
    baseline = fitz.Point(box_v.x0 + pad, box_v.y1 - fs * 0.42) * m
    page.insert_text(
        baseline,
        label,
        fontname="hebo",
        fontsize=fs,
        color=HIGHLIGHT_COLOR,
        rotate=page.rotation,
    )


# ---------------------------------------------------------------- storage


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _use_pg() -> bool:
    global _tables_ready
    if not dbmod.USE_POSTGRES or dbmod.SessionLocal is None or dbmod.engine is None:
        return False
    if not _tables_ready:
        from app.models.drawing_version import DrawingMaster, DrawingVersion

        dbmod.Base.metadata.create_all(
            bind=dbmod.engine, tables=[DrawingMaster.__table__, DrawingVersion.__table__]
        )
        _tables_ready = True
    return True


def _json_load() -> dict:
    if JSON_PATH.exists():
        return json.loads(JSON_PATH.read_text(encoding="utf-8"))
    return {"masters": {}, "versions": []}


def _json_save(db: dict) -> None:
    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = JSON_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(db, indent=2), encoding="utf-8")
    tmp.replace(JSON_PATH)


def _version_dict(v) -> dict:
    return {
        "drawing_key": v.drawing_key,
        "version": v.version,
        "job_id": v.job_id,
        "file_hash": v.file_hash,
        "revision": v.revision,
        "created_by": v.created_by,
        "balloon_map": json.loads(v.balloon_map_json or "[]"),
        "changes": json.loads(v.changes_json or "[]"),
        "created_at": v.created_at.isoformat(timespec="seconds") if v.created_at else "",
    }


def get_master(key: str) -> dict | None:
    if _use_pg():
        from app.models.drawing_version import DrawingMaster

        with dbmod.SessionLocal() as db:
            m = db.get(DrawingMaster, key)
            if m is None:
                return None
            return {
                "drawing_key": m.drawing_key, "part_number": m.part_number, "file_name": m.file_name,
                "max_balloon": m.max_balloon, "latest_version": m.latest_version,
            }
    return _json_load()["masters"].get(key)


def get_version(key: str, version: int) -> dict | None:
    if _use_pg():
        from sqlalchemy import select

        from app.models.drawing_version import DrawingVersion

        with dbmod.SessionLocal() as db:
            v = db.scalar(select(DrawingVersion).where(
                DrawingVersion.drawing_key == key, DrawingVersion.version == version))
            return _version_dict(v) if v else None
    for v in _json_load()["versions"]:
        if v["drawing_key"] == key and v["version"] == version:
            return v
    return None


def list_versions(key: str) -> list[dict]:
    if _use_pg():
        from sqlalchemy import select

        from app.models.drawing_version import DrawingVersion

        with dbmod.SessionLocal() as db:
            rows = db.scalars(select(DrawingVersion).where(
                DrawingVersion.drawing_key == key).order_by(DrawingVersion.version)).all()
            return [_version_dict(v) for v in rows]
    return sorted((v for v in _json_load()["versions"] if v["drawing_key"] == key), key=lambda v: v["version"])


def create_version(
    key: str,
    *,
    part_number: str,
    file_name: str,
    job_id: str,
    file_hash: str,
    revision: str,
    created_by: str,
    balloon_map: list[dict],
    changes: list[dict],
    max_balloon: int,
) -> int:
    """Append the next version (never overwrites). Returns its version number."""
    with _lock:
        if _use_pg():
            from app.models.drawing_version import DrawingMaster, DrawingVersion

            with dbmod.SessionLocal() as db:
                m = db.get(DrawingMaster, key, with_for_update=True)
                if m is None:
                    m = DrawingMaster(drawing_key=key, part_number=part_number, file_name=file_name,
                                      max_balloon=0, latest_version=0)
                    db.add(m)
                n = int(m.latest_version or 0) + 1
                db.add(DrawingVersion(
                    id=secrets.token_hex(12), drawing_key=key, version=n, job_id=job_id,
                    file_hash=file_hash, revision=revision, created_by=created_by,
                    balloon_map_json=json.dumps(balloon_map), auto_map_json=json.dumps(balloon_map),
                    changes_json=json.dumps(changes),
                ))
                m.latest_version = n
                m.max_balloon = max(int(m.max_balloon or 0), max_balloon)
                if part_number:
                    m.part_number = part_number
                db.commit()
                return n
        db = _json_load()
        m = db["masters"].setdefault(key, {
            "drawing_key": key, "part_number": part_number, "file_name": file_name,
            "max_balloon": 0, "latest_version": 0, "created_at": _now(),
        })
        n = int(m["latest_version"]) + 1
        db["versions"].append({
            "drawing_key": key, "version": n, "job_id": job_id, "file_hash": file_hash,
            "revision": revision, "created_by": created_by, "balloon_map": balloon_map,
            "auto_map": balloon_map, "changes": changes, "created_at": _now(),
        })
        m["latest_version"] = n
        m["max_balloon"] = max(int(m["max_balloon"]), max_balloon)
        if part_number:
            m["part_number"] = part_number
        m["updated_at"] = _now()
        _json_save(db)
        return n


def replace_current_map(key: str, version: int, balloon_map: list[dict]) -> int:
    """Save corrected balloons as this version's map (auto map is kept). Returns max_balloon."""
    top = max((int(e["balloon"]) for e in balloon_map), default=0)
    with _lock:
        if _use_pg():
            from sqlalchemy import select

            from app.models.drawing_version import DrawingMaster, DrawingVersion

            with dbmod.SessionLocal() as db:
                v = db.scalar(select(DrawingVersion).where(
                    DrawingVersion.drawing_key == key, DrawingVersion.version == version))
                m = db.get(DrawingMaster, key, with_for_update=True)
                if v is None or m is None:
                    raise KeyError(key)
                v.balloon_map_json = json.dumps(balloon_map)
                m.max_balloon = max(int(m.max_balloon or 0), top)
                db.commit()
                return m.max_balloon
        db = _json_load()
        m = db["masters"].get(key)
        v = next((v for v in db["versions"] if v["drawing_key"] == key and v["version"] == version), None)
        if v is None or m is None:
            raise KeyError(key)
        v["balloon_map"] = balloon_map
        m["max_balloon"] = max(int(m["max_balloon"]), top)
        m["updated_at"] = _now()
        _json_save(db)
        return m["max_balloon"]

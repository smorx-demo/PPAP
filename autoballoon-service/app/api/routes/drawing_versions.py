"""Versioned ballooning: stable balloon numbers + change detection per drawing.

Wraps the existing /api/jobs/{job_id}/balloon flow; detection is unchanged.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.dependencies import require_perm
from app.api.routes.autoballoon import (
    _build_report_rows,
    _draw_balloons_overlay,
    _ensure_measure_columns,
    _job_dir,
    _load_meta,
    _render_preview,
    _save_meta,
    run_balloon,
)
from app.services import drawing_versions as dv

router = APIRouter(tags=["drawing-versions"])


def _src(job_id: str, meta: dict):
    idx = int(meta.get("active_file") or 0)
    files = meta.get("files") or []
    if not files or idx >= len(files):
        raise HTTPException(status_code=400, detail="Job has no source file")
    return idx, _job_dir(job_id) / files[idx]["path"], files[idx].get("name") or ""


def _finalize(job_id: str, meta: dict, user: dict, link: bool | None) -> dict:
    """Apply the saved balloon map to freshly detected balloons in meta."""
    idx, src, file_name = _src(job_id, meta)
    part_number = str(meta.get("part_number") or "").strip()
    key, source = dv.drawing_key_for(part_number, file_name)

    if source == "file_name" and dv.get_master(key) is not None:
        if link is None:
            master = dv.get_master(key) or {}
            meta["drawing_version"] = {"pending": True, "drawing_key": key, "identified_by": source}
            _save_meta(job_id, meta, sync_files=False)
            return {
                "job_id": job_id,
                "count": len(meta.get("balloons") or []),
                "page_count": meta.get("page_count"),
                "needs_confirmation": True,
                "candidate": {
                    "drawing_key": key,
                    "file_name": master.get("file_name") or file_name,
                    "latest_version": master.get("latest_version"),
                },
            }
        if not link:
            key = f"{key}-{job_id.upper()}"  # user said it is a different drawing

    sizes = dv.page_sizes(src)
    fingerprint = dv.drawing_fingerprint(src)
    detected = dv.build_entries(meta.get("balloons") or [], meta.get("report_rows") or [], sizes)
    master = dv.get_master(key)
    revision = str(meta.get("revision") or "")
    created_by = str(user.get("id") or "")

    if master is None:
        entries = [dict(e, balloon=i, status="unchanged") for i, e in enumerate(dv.deterministic_order(detected), 1)]
        changes: list[dict] = []
        version = dv.create_version(
            key, part_number=part_number, file_name=file_name, job_id=job_id, file_hash=fingerprint,
            revision=revision, created_by=created_by, balloon_map=dv.strip_status(entries),
            changes=changes, max_balloon=len(entries),
        )
        created = True
    else:
        latest = dv.get_version(key, int(master["latest_version"])) or {}
        saved_map = latest.get("balloon_map") or []
        if latest.get("file_hash") == fingerprint:
            entries, changes, created = [dict(e, status="unchanged") for e in saved_map], [], False
        else:
            entries, changes, new_max = dv.match_to_map(detected, saved_map, int(master["max_balloon"]))
            created = bool(changes)
        if created:
            version = dv.create_version(
                key, part_number=part_number, file_name=file_name, job_id=job_id, file_hash=fingerprint,
                revision=revision, created_by=created_by, balloon_map=dv.strip_status(entries),
                changes=changes, max_balloon=new_max,
            )
        else:
            # Same drawing as the latest version: show that version's own changes again.
            version = int(master["latest_version"])
            changes = latest.get("changes") or []

    highlight = {int(c["balloon"]) for c in changes if c["status"] in ("Changed", "New")}
    balloons = dv.entries_to_balloons(entries)
    meta["balloons"] = balloons
    meta["report_rows"] = _build_report_rows(src, balloons)
    _ensure_measure_columns(meta)
    out_pdf = _job_dir(job_id) / f"ballooned_{idx}.pdf"

    info = {
        "drawing_key": key,
        "identified_by": source,
        "part_number": part_number,
        "version": version,
        "new_version": created,
        "changes": changes,
        "highlighted": sorted(highlight),
        # Highlight follows the dimension (position), not the balloon number.
        "highlight_features": dv.highlight_features(balloons, highlight, changes),
    }
    meta["drawing_version"] = info
    meta["balloon_numbering"] = "continuous"
    meta["ballooned_pdf"] = out_pdf.name
    # Saved first: the redraw below re-applies the highlight + Version stamp from meta.json.
    _save_meta(job_id, meta, sync_files=False)
    balloons = _draw_balloons_overlay(src, balloons, out_pdf)
    meta["balloons"] = balloons
    _render_preview(out_pdf, _job_dir(job_id) / "balloon_preview.png", 0)
    _save_meta(job_id, meta)
    return {
        "job_id": job_id,
        "count": len(balloons),
        "page_count": meta.get("page_count"),
        "balloons": balloons,
        "drawing_version": info,
    }


@router.post("/api/jobs/{job_id}/balloon/versioned")
def run_balloon_versioned(
    job_id: str,
    file_index: int = 0,
    user: dict = Depends(require_perm("write")),
):
    """Run the existing auto ballooning, then apply this drawing's saved balloon map."""
    run_balloon(
        job_id,
        file_index=file_index,
        passes=1,
        use_zones=True,
        use_tiles=True,
        numbering_mode="continuous",
        user=user,
    )
    return _finalize(job_id, _load_meta(job_id), user, None)


@router.post("/api/jobs/{job_id}/balloon/versioned/confirm")
def confirm_drawing_match(
    job_id: str,
    link: bool,
    user: dict = Depends(require_perm("write")),
):
    """Answer the file-name match question: link=true → same drawing, false → new drawing."""
    meta = _load_meta(job_id)
    if not (meta.get("drawing_version") or {}).get("pending"):
        raise HTTPException(status_code=409, detail="No drawing match is waiting for confirmation")
    return _finalize(job_id, meta, user, link)


@router.post("/api/jobs/{job_id}/drawing-map/save")
def save_current_as_map(job_id: str, user: dict = Depends(require_perm("write"))):
    """Make the job's current (hand-corrected) balloons the map for future uploads."""
    meta = _load_meta(job_id)
    info = meta.get("drawing_version") or {}
    if not info.get("drawing_key") or info.get("pending"):
        raise HTTPException(status_code=409, detail="Run versioned auto ballooning on this job first")
    master = dv.get_master(info["drawing_key"]) or {}
    if int(master.get("latest_version") or 0) != int(info["version"]):
        raise HTTPException(
            status_code=409,
            detail=f"Only the latest version can be updated (latest is Version {master.get('latest_version')})",
        )
    _, src, _ = _src(job_id, meta)
    balloons = meta.get("balloons") or []
    rows = meta.get("report_rows") or _build_report_rows(src, balloons)
    entries = dv.build_entries(balloons, rows, dv.page_sizes(src))
    max_balloon = dv.replace_current_map(info["drawing_key"], int(info["version"]), entries)
    return {"ok": True, "drawing_key": info["drawing_key"], "version": info["version"],
            "count": len(entries), "max_balloon": max_balloon}


@router.get("/api/drawings/{drawing_key}/versions")
def drawing_versions(drawing_key: str, user: dict = Depends(require_perm("read"))):
    master = dv.get_master(drawing_key)
    if master is None:
        raise HTTPException(status_code=404, detail="Drawing not found")
    return {
        "drawing": master,
        "versions": [
            {k: v[k] for k in ("version", "job_id", "revision", "created_at", "changes")}
            | {"balloon_count": len(v.get("balloon_map") or [])}
            for v in dv.list_versions(drawing_key)
        ],
    }


@router.get("/api/drawings/{drawing_key}/versions/{version}")
def drawing_version_detail(drawing_key: str, version: int, user: dict = Depends(require_perm("read"))):
    v = dv.get_version(drawing_key, version)
    if v is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return v

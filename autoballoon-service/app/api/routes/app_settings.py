"""Shared app settings — currently the instrument auto-selection rules.

Stored in the app_settings table (Postgres) or backend/data/app_settings.json.
Defaults live in the frontend (instrument_rules.json); a missing value means "use defaults".
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.dependencies import require_admin, require_perm
from app.core import database as dbmod

router = APIRouter(prefix="/api/settings", tags=["settings"])

ROOT = Path(__file__).resolve().parents[3]  # backend/
JSON_PATH = ROOT / "data" / "app_settings.json"
INSTRUMENT_RULES_KEY = "instrument_rules"

_lock = threading.Lock()
_table_ready = False


class InstrumentRuleIn(BaseModel):
    name: str
    resolution_mm: float
    min_mm: float | None = None
    max_mm: float | None = None
    features: list[str] = Field(default_factory=list)
    cost_rank: int
    enabled: bool = True


class InstrumentRulesIn(BaseModel):
    accuracy_ratio: float
    fallback_accuracy_ratio: float | None = None
    instruments: list[InstrumentRuleIn]


def _validate(body: InstrumentRulesIn) -> list[str]:
    errs: list[str] = []
    if body.accuracy_ratio <= 0:
        errs.append("Accuracy ratio must be > 0")
    if body.fallback_accuracy_ratio is not None and body.fallback_accuracy_ratio <= 0:
        errs.append("Fallback ratio must be > 0")
    if not body.instruments:
        errs.append("At least one instrument is required")
    for i in body.instruments:
        if i.resolution_mm <= 0:
            errs.append(f"{i.name}: resolution must be > 0")
        if i.min_mm is not None and i.min_mm < 0:
            errs.append(f"{i.name}: min range must be ≥ 0")
        if i.max_mm is not None and i.max_mm <= (i.min_mm or 0):
            errs.append(f"{i.name}: max range must be > min range")
        if i.cost_rank < 1:
            errs.append(f"{i.name}: priority must be a positive integer")
    return errs


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _use_pg() -> bool:
    global _table_ready
    if not dbmod.USE_POSTGRES or dbmod.SessionLocal is None or dbmod.engine is None:
        return False
    if not _table_ready:
        from app.models.app_setting import AppSetting

        dbmod.Base.metadata.create_all(bind=dbmod.engine, tables=[AppSetting.__table__])
        _table_ready = True
    return True


def _read(key: str) -> dict | None:
    if _use_pg():
        from app.models.app_setting import AppSetting

        with dbmod.SessionLocal() as db:
            row = db.get(AppSetting, key)
            if row is None:
                return None
            return {
                "value": json.loads(row.value_json or "null"),
                "updated_by": row.updated_by,
                "updated_at": row.updated_at.isoformat(timespec="seconds") if row.updated_at else "",
            }
    if not JSON_PATH.exists():
        return None
    return json.loads(JSON_PATH.read_text(encoding="utf-8")).get(key)


def _write(key: str, value: dict, user: str) -> dict:
    with _lock:
        if _use_pg():
            from app.models.app_setting import AppSetting

            with dbmod.SessionLocal() as db:
                row = db.get(AppSetting, key)
                if row is None:
                    row = AppSetting(key=key)
                    db.add(row)
                row.value_json = json.dumps(value)
                row.updated_by = user
                row.updated_at = datetime.now(timezone.utc)
                db.commit()
        else:
            data = json.loads(JSON_PATH.read_text(encoding="utf-8")) if JSON_PATH.exists() else {}
            data[key] = {"value": value, "updated_by": user, "updated_at": _now()}
            JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = JSON_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(JSON_PATH)
    return _read(key) or {}


@router.get("/instrument-rules")
def get_instrument_rules(user: dict = Depends(require_perm("read"))):
    """Saved rules (null = use built-in defaults) and whether this user may edit them."""
    saved = _read(INSTRUMENT_RULES_KEY) or {}
    return {
        "rules": saved.get("value"),
        "updated_by": saved.get("updated_by", ""),
        "updated_at": saved.get("updated_at", ""),
        "can_edit": user.get("role") == "super_admin",
    }


@router.put("/instrument-rules")
def put_instrument_rules(body: InstrumentRulesIn, user: dict = Depends(require_admin)):
    errs = _validate(body)
    if errs:
        raise HTTPException(status_code=422, detail="; ".join(errs))
    saved = _write(INSTRUMENT_RULES_KEY, body.model_dump(), str(user.get("username") or user.get("id") or ""))
    return {"rules": saved.get("value"), "updated_by": saved.get("updated_by", ""),
            "updated_at": saved.get("updated_at", ""), "can_edit": True}

"""Application settings (env-driven)."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]  # backend/
load_dotenv(ROOT / ".env")

DATA = ROOT / "data"
DATA.mkdir(parents=True, exist_ok=True)
UPLOADS = DATA / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
JOBS = DATA / "jobs"
JOBS.mkdir(parents=True, exist_ok=True)
STATIC = ROOT / "static"


class Settings:
    costsheet_admin_portal_only: bool = (
        (os.getenv("COSTSHEET_ADMIN_PORTAL_ONLY") or "").strip().lower()
        in {"1", "true", "yes"}
    )
    database_url: str = (os.getenv("DATABASE_URL") or "").strip()
    # Production compose points Inspection at its own local Postgres service.
    # This takes precedence over legacy DATABASE_URL values in old env files.
    if (os.getenv("INSPECTION_USE_LOCAL_POSTGRES") or "").strip().lower() in {"1", "true", "yes"}:
        pg_user = quote((os.getenv("POSTGRES_USER") or "postgres").strip(), safe="")
        pg_password = quote(os.getenv("POSTGRES_PASSWORD") or "", safe="")
        pg_database = quote((os.getenv("POSTGRES_DB") or "inspection").strip(), safe="")
        database_url = f"postgresql://{pg_user}:{pg_password}@db:5432/{pg_database}"
    jwt_secret: str = os.getenv("JWT_SECRET", "smorx-dev-secret-change-in-prod")
    jwt_algorithm: str = "HS256"
    pwd_pepper: str = os.getenv("PWD_PEPPER", "smorx-pepper")
    aws_access_key_id: str = (os.getenv("AWS_ACCESS_KEY_ID") or "").strip()
    aws_secret_access_key: str = (os.getenv("AWS_SECRET_ACCESS_KEY") or "").strip()
    aws_s3_bucket: str = (os.getenv("AWS_S3_BUCKET") or "").strip()  # PPAP: no default bucket, local ./data storage
    aws_region: str = (os.getenv("AWS_REGION") or "us-east-1").strip()
    aws_s3_prefix: str = (os.getenv("AWS_S3_PREFIX") or "").strip().strip("/")
    # Optional override; default matches virtual-hosted–style bucket URL in us-east-1
    aws_s3_url: str = (
        os.getenv("AWS_S3_URL")
        or "https://autoballoon-storage-smorx-prod.s3.us-east-1.amazonaws.com"
    ).strip().rstrip("/")
    # Comma-separated browser origins for hosted web UI (e.g. https://app.example.com)
    cors_origins: str = (os.getenv("CORS_ORIGINS") or "").strip()
    superadmin_email: str = (os.getenv("SUPERADMIN_EMAIL") or "admin@smorx.ai").strip()
    superadmin_username: str = (os.getenv("SUPERADMIN_USERNAME") or "admin").strip()
    superadmin_name: str = (os.getenv("SUPERADMIN_NAME") or "Super Admin").strip()
    superadmin_password: str = os.getenv("SUPERADMIN_PASSWORD") or "admin123"


settings = Settings()


def cors_origin_list() -> list[str]:
    """Extra CORS origins from CORS_ORIGINS env (comma-separated)."""
    raw = settings.cors_origins
    if not raw:
        return []
    return [o.strip() for o in raw.split(",") if o.strip()]

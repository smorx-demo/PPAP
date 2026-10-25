from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DrawingMaster(Base):
    """One row per physical drawing (identified by part number or file name)."""

    __tablename__ = "drawing_masters"

    drawing_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    part_number: Mapped[str] = mapped_column(String(120), default="")
    file_name: Mapped[str] = mapped_column(String(255), default="")
    # Highest balloon number ever issued — new features continue after it; never reused.
    max_balloon: Mapped[int] = mapped_column(Integer, default=0)
    latest_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class DrawingVersion(Base):
    """Immutable snapshot of a drawing's balloon map at one version."""

    __tablename__ = "drawing_versions"
    __table_args__ = (UniqueConstraint("drawing_key", "version", name="uq_drawing_version"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    drawing_key: Mapped[str] = mapped_column(String(255), index=True)
    version: Mapped[int] = mapped_column(Integer)
    job_id: Mapped[str] = mapped_column(String(64), default="")
    file_hash: Mapped[str] = mapped_column(String(64), default="")
    revision: Mapped[str] = mapped_column(String(64), default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    # Current map (may be corrected via "save current balloons as map").
    balloon_map_json: Mapped[str] = mapped_column(Text, default="[]")
    # Map exactly as produced by auto ballooning for this version.
    auto_map_json: Mapped[str] = mapped_column(Text, default="[]")
    changes_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

from __future__ import annotations

from pathlib import Path
from typing import Any


def build_manifest(
    *,
    title: str,
    source_type: str,
    source_path: str,
    sections: list[dict[str, Any]] | None = None,
    assets: list[str] | None = None,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "title": title,
        "sourceType": source_type,
        "sourcePath": source_path,
        "sections": sections or [],
        "assets": assets or [],
        "warnings": warnings or [],
    }


def section(anchor: str, index: int, heading: str | None) -> dict[str, Any]:
    return {
        "heading": heading,
        "anchor": anchor,
        "index": index,
    }


def title_from_path(path: Path) -> str:
    return path.stem or "未命名文档"


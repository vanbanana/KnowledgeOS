from __future__ import annotations

from pathlib import Path

from .common import build_manifest, section, title_from_path


def parse_md_txt(path: Path, source_type: str) -> dict:
    content = path.read_text(encoding="utf-8", errors="ignore").strip()
    title = title_from_path(path)
    lines = content.splitlines()
    sections = []
    for index, line in enumerate(lines):
        if line.startswith("#"):
            sections.append(section(f"line-{index + 1}", len(sections), line.lstrip("# ").strip() or None))

    markdown = content if source_type == "md" else f"# {title}\n\n{content}"
    return {
        "ok": True,
        "markdown": markdown,
        "manifest": build_manifest(
            title=title,
            source_type=source_type,
            source_path=str(path),
            sections=sections,
        ),
    }


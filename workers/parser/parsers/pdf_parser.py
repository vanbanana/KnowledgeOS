from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader

from .common import build_manifest, section, title_from_path


def parse_pdf(path: Path, source_type: str) -> dict:
    reader = PdfReader(str(path))
    pages = []
    sections = []
    warnings: list[str] = []

    for index, page in enumerate(reader.pages):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        if not text:
            warnings.append(f"第 {index + 1} 页未提取到文本")
            continue
        sections.append(section(f"page-{index + 1}", index, f"第 {index + 1} 页"))
        pages.append(f"## 第 {index + 1} 页\n\n{text}")

    title = reader.metadata.title if reader.metadata and reader.metadata.title else title_from_path(path)
    markdown = f"# {title}\n\n" + "\n\n".join(pages)
    return {
        "ok": True,
        "markdown": markdown.strip(),
        "manifest": build_manifest(
            title=title,
            source_type=source_type,
            source_path=str(path),
            sections=sections,
            warnings=warnings,
        ),
    }


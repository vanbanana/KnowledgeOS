from __future__ import annotations

from pathlib import Path

from docx import Document

from .common import build_manifest, section, title_from_path


def parse_docx(path: Path, source_type: str) -> dict:
    document = Document(str(path))
    chunks = []
    sections = []
    paragraph_index = 0

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style_name = paragraph.style.name.lower() if paragraph.style and paragraph.style.name else ""
        if style_name.startswith("heading"):
            level = "".join(ch for ch in style_name if ch.isdigit()) or "1"
            chunks.append(f"{'#' * max(int(level), 1)} {text}")
            sections.append(section(f"paragraph-{paragraph_index + 1}", len(sections), text))
        else:
            chunks.append(text)
        paragraph_index += 1

    markdown = "\n\n".join(chunks).strip()
    title = title_from_path(path)
    if not markdown.startswith("#"):
        markdown = f"# {title}\n\n{markdown}"

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

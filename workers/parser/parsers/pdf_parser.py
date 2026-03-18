from __future__ import annotations

from pathlib import Path

from markitdown import MarkItDown

from .common import build_manifest, section, title_from_path


def parse_pdf(path: Path, source_type: str) -> dict:
    converter = MarkItDown(enable_plugins=False)
    result = converter.convert(path)
    markdown = (result.markdown or "").strip()
    title = (result.title or title_from_path(path)).strip() or title_from_path(path)
    warnings: list[str] = []

    if not markdown:
        markdown = (
            f"# {title}\n\n"
            "当前 PDF 没有提取到可转换的正文内容。"
            "如果这是扫描件，后续需要接入 OCR 才能恢复正文。"
        )
        warnings.append("PDF 未提取到正文，已写入占位内容")

    sections = collect_sections(markdown, title)
    return {
        "ok": True,
        "markdown": markdown,
        "manifest": build_manifest(
            title=title,
            source_type=source_type,
            source_path=str(path),
            sections=sections,
            warnings=warnings,
        ),
    }


def collect_sections(markdown: str, fallback_title: str) -> list[dict]:
    sections: list[dict] = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        depth = len(stripped) - len(stripped.lstrip("#"))
        if depth <= 0 or len(stripped) <= depth or stripped[depth] != " ":
            continue
        heading = stripped[depth + 1 :].strip()
        if not heading:
            continue
        sections.append(section(slugify_anchor(heading), len(sections), heading))

    if sections:
        return sections

    return [section("document-1", 0, fallback_title)]


def slugify_anchor(value: str) -> str:
    output = []
    previous_dash = False
    for character in value.lower():
        if character.isalnum():
            output.append(character)
            previous_dash = False
            continue
        if character.isspace() or character in {"-", "_", "/"}:
            if not previous_dash:
                output.append("-")
                previous_dash = True
    return "".join(output).strip("-") or "section"

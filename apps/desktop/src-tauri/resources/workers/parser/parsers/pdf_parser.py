from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime, timezone

try:
    import fitz  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    fitz = None

from pypdf import PdfReader

from .common import build_manifest, section, title_from_path


def parse_pdf(path: Path, source_type: str, progress_path: str | None = None) -> dict:
    progress_file = Path(progress_path) if progress_path else None
    if fitz is not None:
        title, page_count, text_pages, page_markdown_parts = extract_with_pymupdf(path, progress_file)
        warnings = []
        if page_count > 0 and text_pages < page_count:
            warnings.append(
                f"共 {page_count} 页，已直接提取文本 {text_pages} 页，其余页面建议走 OCR。"
            )
    else:
        title, page_count, text_pages, page_markdown_parts = extract_with_pypdf(path, progress_file)
        warnings = ["未检测到 PyMuPDF，当前使用 pypdf 回退解析。"]
        if page_count > 0 and text_pages < page_count:
            warnings.append(
                f"共 {page_count} 页，已直接提取文本 {text_pages} 页，其余页面建议走 OCR。"
            )

    markdown = f"# {title}\n\n"
    if page_markdown_parts:
        markdown += "\n\n".join(page_markdown_parts).strip()
    else:
        markdown += (
            "当前 PDF 没有提取到可转换的正文内容。"
            "如果这是扫描件，后续会自动走 OCR 流程。"
        )
        warnings.append("PDF 未提取到正文，可能是扫描件")

    write_progress(progress_file, "pdf_extract_done", page_count, page_count, "文本抽取完成")

    markdown = markdown.strip()
    sections = collect_sections(markdown, title)
    manifest = build_manifest(
        title=title,
        source_type=source_type,
        source_path=str(path),
        sections=sections,
        warnings=warnings,
    )

    return {
        "ok": True,
        "markdown": markdown,
        "manifest": manifest,
    }


def extract_with_pymupdf(path: Path, progress_file: Path | None) -> tuple[str, int, int, list[str]]:
    with fitz.open(path) as document:
        title = read_title(document.metadata or {}, path)
        page_markdown_parts: list[str] = []
        text_pages = 0
        total_pages = document.page_count

        for page_index in range(total_pages):
            write_progress(
                progress_file,
                "pdf_extracting",
                page_index + 1,
                total_pages,
                f"正在解析第 {page_index + 1}/{total_pages} 页",
            )
            page = document.load_page(page_index)
            page_text = (page.get_text("text") or "").strip()
            if not page_text:
                continue
            text_pages += 1
            cleaned_text = "\n".join(line.rstrip() for line in page_text.splitlines()).strip()
            if not cleaned_text:
                continue
            page_markdown_parts.append(f"## 第{page_index + 1}页\n\n{cleaned_text}")

        return title, total_pages, text_pages, page_markdown_parts


def extract_with_pypdf(path: Path, progress_file: Path | None) -> tuple[str, int, int, list[str]]:
    reader = PdfReader(str(path))
    metadata = {}
    if reader.metadata:
        metadata = {"title": reader.metadata.title or ""}
    title = read_title(metadata, path)
    page_markdown_parts: list[str] = []
    text_pages = 0
    total_pages = len(reader.pages)

    for page_index, page in enumerate(reader.pages):
        write_progress(
            progress_file,
            "pdf_extracting",
            page_index + 1,
            total_pages,
            f"正在解析第 {page_index + 1}/{total_pages} 页",
        )
        page_text = (page.extract_text() or "").strip()
        if not page_text:
            continue
        text_pages += 1
        cleaned_text = "\n".join(line.rstrip() for line in page_text.splitlines()).strip()
        if not cleaned_text:
            continue
        page_markdown_parts.append(f"## 第{page_index + 1}页\n\n{cleaned_text}")

    return title, total_pages, text_pages, page_markdown_parts


def read_title(metadata: dict, path: Path) -> str:
    raw_title = (metadata.get("title") or "").strip()
    if raw_title:
        return raw_title
    return title_from_path(path)


def write_progress(
    progress_file: Path | None,
    phase: str,
    current_page: int,
    total_pages: int,
    message: str,
) -> None:
    if progress_file is None:
        return
    payload = {
        "phase": phase,
        "currentPage": current_page,
        "totalPages": total_pages,
        "message": message,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    progress_file.parent.mkdir(parents=True, exist_ok=True)
    progress_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


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

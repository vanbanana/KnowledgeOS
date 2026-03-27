from __future__ import annotations

import contextlib
import io
import json
import os
import re
from pathlib import Path
from datetime import datetime, timezone

try:
    import fitz  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    fitz = None

try:
    from docling.document_converter import (  # type: ignore[import-not-found]
        DocumentConverter,
        InputFormat,
        PdfFormatOption,
    )
    from docling.datamodel.pipeline_options import (  # type: ignore[import-not-found]
        PdfPipelineOptions,
    )
except Exception:  # pragma: no cover
    DocumentConverter = None
    InputFormat = None
    PdfFormatOption = None
    PdfPipelineOptions = None

from pypdf import PdfReader

from .common import build_manifest, section, title_from_path


def parse_pdf(path: Path, source_type: str, progress_path: str | None = None) -> dict:
    progress_file = Path(progress_path) if progress_path else None
    warnings: list[str] = []
    title = title_from_path(path)
    page_count = 0
    text_pages = 0
    page_markdown_parts: list[str] = []

    probed_pages = read_pdf_page_count(path)
    use_docling, skip_reason = should_try_docling()
    if not use_docling and skip_reason:
        warnings.append(skip_reason)
        write_progress(progress_file, "pdf_docling_skip", 0, probed_pages, skip_reason)

    if use_docling:
        try:
            (
                title,
                page_count,
                text_pages,
                page_markdown_parts,
                docling_warnings,
            ) = extract_with_docling(path, progress_file)
            warnings.extend(docling_warnings)
            warnings.append("已使用 Docling 快速解析链路。")
        except Exception as error:
            warning = f"Docling 解析失败，已回退传统解析：{compact_error_message(error)}"
            warnings.append(warning)
            write_progress(
                progress_file,
                "pdf_docling_failed",
                0,
                probed_pages,
                warning,
            )

    if not page_markdown_parts:
        if fitz is not None:
            title, page_count, text_pages, page_markdown_parts = extract_with_pymupdf(
                path, progress_file
            )
            if page_count > 0 and text_pages < page_count:
                warnings.append(
                    f"共 {page_count} 页，已直接提取文本 {text_pages} 页，其余页面建议走 OCR。"
                )
        else:
            title, page_count, text_pages, page_markdown_parts = extract_with_pypdf(
                path, progress_file
            )
            warnings.append("未检测到 PyMuPDF，当前使用 pypdf 回退解析。")
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


def should_try_docling() -> tuple[bool, str | None]:
    engine = os.environ.get("KNOWFLOW_PDF_PARSER_ENGINE", "").strip().lower()
    if engine in {"legacy", "pymupdf", "pypdf", "fitz"}:
        return False, "已按配置禁用 Docling，使用传统解析。"
    return True, None


def extract_with_docling(
    path: Path, progress_file: Path | None
) -> tuple[str, int, int, list[str], list[str]]:
    if DocumentConverter is None or InputFormat is None or PdfFormatOption is None or PdfPipelineOptions is None:
        raise RuntimeError("未安装 docling 依赖")

    total_pages = read_pdf_page_count(path)
    write_progress(
        progress_file,
        "pdf_docling_init",
        0,
        total_pages,
        "正在初始化 Docling 快速解析引擎",
    )
    converter = build_docling_converter()
    chunk_size = read_positive_int_env(
        ["KNOWFLOW_DOCLING_PAGE_CHUNK_SIZE", "KNOWLEDGEOS_DOCLING_PAGE_CHUNK_SIZE"],
        default_value=4,
    )
    title = title_from_path(path)
    page_text_map: dict[int, str] = {}

    if total_pages <= 0:
        write_progress(
            progress_file,
            "pdf_docling_parse",
            0,
            0,
            "Docling 正在解析（未获取到总页数，走单次模式）",
        )
        result = run_docling_convert(converter, path)
        status_text = str(getattr(result, "status", "")).lower()
        if "success" not in status_text:
            raise RuntimeError(f"Docling 返回状态异常：{status_text or 'unknown'}")
        document = getattr(result, "document", None)
        if document is None:
            raise RuntimeError("Docling 未返回 document")
        title = read_title_from_docling(result, path)
        full_md = safe_docling_markdown(
            document,
            page_break_placeholder="\n\n<!-- KNOWFLOW_PAGE_BREAK -->\n\n",
        )
        full_md = normalize_docling_markdown(full_md)
        chunks = split_docling_markdown_by_page(full_md)
        if chunks:
            for idx, chunk in enumerate(chunks, start=1):
                page_text_map[idx] = chunk
        elif full_md:
            page_text_map[1] = full_md
        total_pages = len(getattr(result, "pages", []) or []) or max(len(page_text_map), 1)
    else:
        for chunk_start in range(1, total_pages + 1, chunk_size):
            chunk_end = min(total_pages, chunk_start + chunk_size - 1)
            write_progress(
                progress_file,
                "pdf_docling_parse",
                chunk_start,
                total_pages,
                f"Docling 正在解析第 {chunk_start}-{chunk_end}/{total_pages} 页",
            )
            result = run_docling_convert(
                converter,
                path,
                page_range=(chunk_start, chunk_end),
            )
            status_text = str(getattr(result, "status", "")).lower()
            if "success" not in status_text:
                raise RuntimeError(f"Docling 返回状态异常：{status_text or 'unknown'}")

            if title == path.stem:
                title = read_title_from_docling(result, path)
            document = getattr(result, "document", None)
            if document is None:
                continue

            extracted_any = False
            for page_number in range(chunk_start, chunk_end + 1):
                write_progress(
                    progress_file,
                    "pdf_docling_extracting",
                    page_number,
                    total_pages,
                    f"Docling 正在提取第 {page_number}/{total_pages} 页文本",
                )
                local_page_no = page_number - chunk_start + 1
                page_md = safe_docling_markdown(document, page_no=local_page_no)
                if not page_md and local_page_no != page_number:
                    page_md = safe_docling_markdown(document, page_no=page_number)
                page_md = normalize_docling_markdown(page_md)
                if not page_md:
                    continue
                extracted_any = True
                page_text_map[page_number] = page_md

            if extracted_any:
                continue

            fallback_md = safe_docling_markdown(
                document,
                page_break_placeholder="\n\n<!-- KNOWFLOW_PAGE_BREAK -->\n\n",
            )
            fallback_md = normalize_docling_markdown(fallback_md)
            fallback_chunks = split_docling_markdown_by_page(fallback_md)
            for idx, chunk_text in enumerate(fallback_chunks):
                actual_page = chunk_start + idx
                if actual_page > chunk_end:
                    break
                if chunk_text:
                    page_text_map[actual_page] = chunk_text

    warnings: list[str] = []
    page_count = total_pages
    if page_count <= 0 and page_text_map:
        page_count = max(page_text_map.keys())

    ordered_pages = sorted(page_text_map.items(), key=lambda item: item[0])
    page_markdown_parts = [f"## 第{page}页\n\n{text}" for page, text in ordered_pages]
    text_pages = len(ordered_pages)

    if page_count > 0 and text_pages < page_count:
        warnings.append(f"Docling 共识别 {page_count} 页，提取到文本 {text_pages} 页。")
    if text_pages == 0:
        warnings.append("Docling 未提取到正文，可能是扫描件或版面异常。")

    return title, page_count, text_pages, page_markdown_parts, warnings


def build_docling_converter() -> DocumentConverter:
    pipeline_options = PdfPipelineOptions()
    pipeline_options.force_backend_text = True
    pipeline_options.do_ocr = False
    pipeline_options.do_table_structure = False
    pipeline_options.do_picture_classification = False
    pipeline_options.do_picture_description = False
    pipeline_options.do_code_enrichment = False
    pipeline_options.do_formula_enrichment = False
    pipeline_options.enable_remote_services = False
    pipeline_options.allow_external_plugins = False
    pipeline_options.ocr_batch_size = 1
    pipeline_options.layout_batch_size = 1
    pipeline_options.table_batch_size = 1
    pipeline_options.queue_max_size = 16

    artifacts_path = (
        os.environ.get("KNOWFLOW_DOCLING_ARTIFACTS_PATH", "").strip()
        or os.environ.get("KNOWLEDGEOS_DOCLING_ARTIFACTS_PATH", "").strip()
    )
    if artifacts_path:
        pipeline_options.artifacts_path = artifacts_path

    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        },
    )


def run_docling_convert(
    converter: DocumentConverter,
    path: Path,
    page_range: tuple[int, int] | None = None,
):
    captured_stdout = io.StringIO()
    with contextlib.redirect_stdout(captured_stdout):
        if page_range:
            return converter.convert(path, page_range=page_range)
        return converter.convert(path)


def safe_docling_markdown(
    document: object,
    page_no: int | None = None,
    page_break_placeholder: str | None = None,
) -> str:
    captured_stdout = io.StringIO()
    with contextlib.redirect_stdout(captured_stdout):
        if hasattr(document, "export_to_markdown"):
            kwargs = {}
            if page_no is not None:
                kwargs["page_no"] = page_no
            if page_break_placeholder is not None:
                kwargs["page_break_placeholder"] = page_break_placeholder
            return str(document.export_to_markdown(**kwargs))
        if hasattr(document, "to_markdown"):
            return str(document.to_markdown())
    return ""


def normalize_docling_markdown(markdown: str) -> str:
    if not markdown:
        return ""
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    escaped_newline_count = normalized.count("\\n")
    actual_newline_count = normalized.count("\n")
    if escaped_newline_count >= 2 and escaped_newline_count >= actual_newline_count:
        normalized = normalized.replace("\\n", "\n").replace("\\t", "\t")
    normalized = "\n".join(line.rstrip() for line in normalized.splitlines())
    normalized = normalized.strip()
    if not normalized:
        return ""
    return enhance_code_fences(normalized)


def split_docling_markdown_by_page(markdown: str) -> list[str]:
    if not markdown:
        return []
    marker = "<!-- KNOWFLOW_PAGE_BREAK -->"
    if marker not in markdown:
        return []
    return [chunk.strip() for chunk in markdown.split(marker) if chunk.strip()]


def enhance_code_fences(markdown: str) -> str:
    lines = markdown.splitlines()
    output: list[str] = []
    code_buffer: list[str] = []

    def flush_code_buffer() -> None:
        nonlocal code_buffer
        if not code_buffer:
            return
        merged_text = "\n".join(code_buffer)
        code_signal = sum(1 for line in code_buffer if is_code_like_line(line))
        if len(code_buffer) >= 2 and code_signal >= 2:
            output.append("```cpp")
            output.extend(code_buffer)
            output.append("```")
        else:
            output.extend(code_buffer)
        code_buffer = []

    for line in lines:
        if is_code_like_line(line):
            code_buffer.append(line)
            continue
        flush_code_buffer()
        output.append(line)

    flush_code_buffer()
    return "\n".join(output).strip()


def is_code_like_line(line: str) -> bool:
    value = line.strip()
    if not value:
        return False
    if value.startswith("```"):
        return True
    if re.search(r"[{};#]", value):
        return True
    if re.search(r"(::|->|=>|==|!=|<=|>=)", value):
        return True
    if re.match(
        r"^(if|else|for|while|switch|case|return|class|struct|template|public|private|protected|void|int|char|string|const|static)\b",
        value,
    ):
        return True
    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*$", value):
        return True
    return False


def compact_error_message(error: Exception) -> str:
    message = str(error).strip().replace("\r", " ").replace("\n", " ")
    if len(message) > 160:
        return f"{message[:157]}..."
    return message or error.__class__.__name__


def read_title_from_docling(result: object, path: Path) -> str:
    document = getattr(result, "document", None)
    if document is not None:
        for attr in ("name", "title"):
            value = getattr(document, attr, None)
            if isinstance(value, str) and value.strip():
                return value.strip()

    input_obj = getattr(result, "input", None)
    if input_obj is not None:
        for attr in ("name", "filename"):
            value = getattr(input_obj, attr, None)
            if isinstance(value, str) and value.strip():
                return value.strip()

    return title_from_path(path)


def read_pdf_page_count(path: Path) -> int:
    try:
        reader = PdfReader(str(path))
        return len(reader.pages)
    except Exception:
        return 0


def read_positive_int_env(keys: list[str], default_value: int) -> int:
    for key in keys:
        raw = os.environ.get(key, "").strip()
        if not raw:
            continue
        try:
            value = int(raw)
        except ValueError:
            continue
        if value > 0:
            return value
    return default_value


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

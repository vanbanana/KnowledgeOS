from __future__ import annotations

import json
import subprocess
from pathlib import Path

from docx import Document
from pptx import Presentation
from pypdf import PdfWriter


ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "workers" / "parser" / "main.py"


def test_health() -> None:
    completed = subprocess.run(
        ["python", str(WORKER), "health"],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True


def test_parse_file(tmp_path: Path) -> None:
    source = tmp_path / "sample.md"
    source.write_text("# 示例\n\n内容", encoding="utf-8")

    completed = subprocess.run(
        [
            "python",
            str(WORKER),
            "parse_file",
            "--file-path",
            str(source),
            "--source-type",
            "md",
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["manifest"]["title"] == "sample"


def test_parse_docx(tmp_path: Path) -> None:
    source = tmp_path / "sample.docx"
    document = Document()
    document.add_heading("文档标题", level=1)
    document.add_paragraph("这里是正文。")
    document.save(source)

    completed = subprocess.run(
        [
            "python",
            str(WORKER),
            "parse_file",
            "--file-path",
            str(source),
            "--source-type",
            "docx",
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert "文档标题" in payload["markdown"]


def test_parse_pptx(tmp_path: Path) -> None:
    source = tmp_path / "sample.pptx"
    presentation = Presentation()
    slide_layout = presentation.slide_layouts[1]
    slide = presentation.slides.add_slide(slide_layout)
    slide.shapes.title.text = "第一页"
    slide.placeholders[1].text = "要点一\n要点二"
    presentation.save(source)

    completed = subprocess.run(
        [
            "python",
            str(WORKER),
            "parse_file",
            "--file-path",
            str(source),
            "--source-type",
            "pptx",
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert "第一页" in payload["markdown"]


def test_parse_pdf(tmp_path: Path) -> None:
    source = tmp_path / "sample.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    with source.open("wb") as handle:
        writer.write(handle)

    completed = subprocess.run(
        [
            "python",
            str(WORKER),
            "parse_file",
            "--file-path",
            str(source),
            "--source-type",
            "pdf",
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["manifest"]["sourceType"] == "pdf"

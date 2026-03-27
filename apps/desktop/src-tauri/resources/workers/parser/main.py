from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from parsers import generate_pptx, parse_docx, parse_md_txt, parse_pdf, parse_pptx

VERSION = "0.1.0"


def health() -> dict[str, Any]:
    return {"ok": True, "version": VERSION}


def parse_file(file_path: str, source_type: str, progress_path: str | None = None) -> dict[str, Any]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    if source_type in {"md", "txt"}:
        return parse_md_txt(path, source_type)
    if source_type == "pdf":
        return parse_pdf(path, source_type, progress_path)
    if source_type == "pptx":
        return parse_pptx(path, source_type)
    if source_type == "docx":
        return parse_docx(path, source_type)

    raise ValueError(f"暂不支持的 source_type: {source_type}")


def build_pptx(output_path: str, presentation_json: str) -> dict[str, Any]:
    return generate_pptx(output_path, presentation_json)


def main() -> None:
    parser = argparse.ArgumentParser(description="KnowledgeOS parser worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health", help="健康检查")

    parse_parser = subparsers.add_parser("parse_file", help="解析单个文件")
    parse_parser.add_argument("--file-path", required=True)
    parse_parser.add_argument("--source-type", required=True)
    parse_parser.add_argument("--progress-path", required=False)

    pptx_parser = subparsers.add_parser("generate_pptx", help="生成演示文稿文件")
    pptx_parser.add_argument("--output-path", required=True)
    pptx_parser.add_argument("--presentation-json", required=True)

    args = parser.parse_args()

    if args.command == "health":
        print(json.dumps(health(), ensure_ascii=False))
        return

    if args.command == "generate_pptx":
        result = build_pptx(args.output_path, args.presentation_json)
        print(json.dumps(result, ensure_ascii=False))
        return

    result = parse_file(args.file_path, args.source_type, args.progress_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

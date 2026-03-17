from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from parsers import parse_docx, parse_md_txt, parse_pdf, parse_pptx

VERSION = "0.1.0"


def health() -> dict[str, Any]:
    return {"ok": True, "version": VERSION}


def parse_file(file_path: str, source_type: str) -> dict[str, Any]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    if source_type in {"md", "txt"}:
        return parse_md_txt(path, source_type)
    if source_type == "pdf":
        return parse_pdf(path, source_type)
    if source_type == "pptx":
        return parse_pptx(path, source_type)
    if source_type == "docx":
        return parse_docx(path, source_type)

    raise ValueError(f"暂不支持的 source_type: {source_type}")


def main() -> None:
    parser = argparse.ArgumentParser(description="KnowledgeOS parser worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health", help="健康检查")

    parse_parser = subparsers.add_parser("parse_file", help="解析单个文件")
    parse_parser.add_argument("--file-path", required=True)
    parse_parser.add_argument("--source-type", required=True)

    args = parser.parse_args()

    if args.command == "health":
        print(json.dumps(health(), ensure_ascii=False))
        return

    result = parse_file(args.file_path, args.source_type)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

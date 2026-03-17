from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

VERSION = "0.1.0"


def health() -> dict[str, Any]:
    return {"ok": True, "version": VERSION}


def parse_file(file_path: str, source_type: str) -> dict[str, Any]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    content = path.read_text(encoding="utf-8", errors="ignore")
    title = path.stem or "未命名文档"
    markdown = content if source_type == "md" else f"# {title}\n\n{content}"

    return {
        "ok": True,
        "markdown": markdown,
        "manifest": {
            "title": title,
            "sourceType": source_type,
            "warnings": [],
        },
    }


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

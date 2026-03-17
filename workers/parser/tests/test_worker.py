from __future__ import annotations

import json
import subprocess
from pathlib import Path


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

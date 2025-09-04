#!/usr/bin/env python3
"""依存ライブラリのライセンス情報を収集しJSONで出力するスクリプト"""
import json
import importlib.metadata as md
from pathlib import Path

# 対象のライブラリ一覧
PACKAGES = [
    "fastapi",
    "uvicorn",
    "httpx",
    "passlib",
    "pyotp",
    "qrcode",
    "python-jose",
    "cryptography",
    "reportlab",
    "python-dotenv",
    "couchdb",
]


def get_license_info(pkg: str) -> dict:
    dist = md.distribution(pkg)
    meta = dist.metadata
    license_name = meta.get("License", "")
    if not license_name:
        for c in meta.get_all("Classifier", []):
            if c.startswith("License ::"):
                license_name = c.split("::")[-1].strip()
                break
    license_text = ""
    for file in dist.files or []:
        name = file.name.lower()
        if "license" in name or "copying" in name:
            path = dist.locate_file(file)
            try:
                license_text = path.read_text(encoding="utf-8", errors="ignore")
                break
            except Exception:
                continue
    return {
        "name": meta.get("Name", pkg),
        "version": dist.version,
        "license": license_name,
        "text": license_text,
    }


def main() -> None:
    data = [get_license_info(p) for p in PACKAGES]
    root = Path(__file__).resolve().parents[2]
    out = root / "frontend" / "public" / "docs" / "dependency_licenses.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

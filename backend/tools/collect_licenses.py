#!/usr/bin/env python3
"""依存ライブラリのライセンス情報を収集しJSONで出力するスクリプト"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, asdict
import importlib.metadata as md
from importlib.metadata import PackageNotFoundError
from pathlib import Path
from typing import Dict, Iterable, List, Optional


# 対象の Python ライブラリ一覧（任意で追加）
PYTHON_PACKAGES = [
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

# ライブラリの用途メタ情報（component/category など）。指定がない場合は backend/runtime とする。
PACKAGE_OVERRIDES: Dict[str, Dict[str, str]] = {
    "reportlab": {"category": "optional"},
    "python-dotenv": {"category": "development"},
}


@dataclass
class LicenseEntry:
    name: str
    version: str
    license: str
    text: str
    source: str
    component: str = "backend"
    category: str = "runtime"
    homepage: Optional[str] = None
    author: Optional[str] = None
    license_url: Optional[str] = None


def _select_license_name(meta: md.PackageMetadata) -> str:
    license_name = meta.get("License", "")
    if license_name:
        return license_name
    for classifier in meta.get_all("Classifier", []):
        if classifier.startswith("License ::"):
            return classifier.split("::")[-1].strip()
    return ""


def _extract_project_urls(meta: md.PackageMetadata) -> Dict[str, str]:
    urls: Dict[str, str] = {}
    for entry in meta.get_all("Project-URL", []) or []:
        if "," in entry:
            label, url = entry.split(",", 1)
            urls[label.strip().lower()] = url.strip()
    return urls


def license_entry_from_dict(data: dict) -> LicenseEntry:
    return LicenseEntry(
        name=data.get("name", ""),
        version=data.get("version", ""),
        license=data.get("license", ""),
        text=data.get("text", ""),
        source=data.get("source", "python"),
        component=data.get("component", "backend"),
        category=data.get("category", "runtime"),
        homepage=data.get("homepage"),
        author=data.get("author"),
        license_url=data.get("license_url"),
    )


def load_existing_data(path: Path) -> List[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        print(f"[collect-licenses] failed to read existing data from {path}")
        return []


def build_existing_lookup(data: Iterable[dict]) -> Dict[str, dict]:
    lookup: Dict[str, dict] = {}
    for item in data:
        name = item.get("name")
        if not name:
            continue
        version = item.get("version") or ""
        key = name.lower()
        lookup.setdefault(key, item)
        if version:
            lookup[f"{key}@{version}"] = item
    return lookup


def collect_python_licenses(
    packages: Iterable[str],
    existing_lookup: Dict[str, dict],
) -> List[LicenseEntry]:
    entries: List[LicenseEntry] = []
    seen: set[str] = set()
    for pkg in packages:
        try:
            dist = md.distribution(pkg)
        except PackageNotFoundError:
            print(f"[collect-licenses] skip python package '{pkg}': not installed")
            continue
        meta = dist.metadata
        license_name = _select_license_name(meta)
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
        urls = _extract_project_urls(meta)
        pkg_name = meta.get("Name", pkg)
        overrides = PACKAGE_OVERRIDES.get(pkg_name.lower(), {})
        entry = LicenseEntry(
            name=pkg_name,
            version=dist.version,
            license=license_name,
            text=license_text,
            component=overrides.get("component", "backend"),
            category=overrides.get("category", "runtime"),
            homepage=meta.get("Home-page") or urls.get("homepage"),
            author=meta.get("Author"),
            license_url=urls.get("license") or urls.get("license url"),
            source="python",
        )
        fallback = (
            existing_lookup.get(f"{pkg_name.lower()}@{dist.version}")
            or existing_lookup.get(pkg_name.lower())
            or existing_lookup.get(f"{pkg.lower()}@{dist.version}")
            or existing_lookup.get(pkg.lower())
        )
        if fallback:
            if not entry.text:
                entry.text = fallback.get("text", "")
            if not entry.license:
                entry.license = fallback.get("license", "")
            if not entry.homepage:
                entry.homepage = fallback.get("homepage")
            if not entry.author:
                entry.author = fallback.get("author")
            if not entry.license_url:
                entry.license_url = fallback.get("license_url")
        entries.append(entry)
        seen.add(pkg_name.lower())

    for pkg in packages:
        key = pkg.lower()
        if key in seen:
            continue
        fallback = existing_lookup.get(key)
        if fallback:
            entries.append(license_entry_from_dict(fallback))
    return entries


def _safe_read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _read_node_package_info(node_modules: Path, name: str) -> Optional[dict]:
    parts = name.split("/")
    package_path = node_modules.joinpath(*parts, "package.json")
    if not package_path.exists():
        return None
    return _safe_read_json(package_path)


def _extract_node_license(data: dict) -> str:
    license_field = data.get("license")
    if isinstance(license_field, str):
        return license_field
    if isinstance(license_field, dict):
        return license_field.get("type", "")
    licenses = data.get("licenses")
    if isinstance(licenses, list) and licenses:
        first = licenses[0]
        if isinstance(first, dict):
            return first.get("type", "")
        if isinstance(first, str):
            return first
    return ""


def _author_to_str(author: Optional[object]) -> Optional[str]:
    if isinstance(author, str):
        return author
    if isinstance(author, dict):
        name = author.get("name")
        email = author.get("email")
        if name and email:
            return f"{name} <{email}>"
        return name or email
    return None


def collect_node_licenses(
    frontend_root: Path,
    existing_lookup: Dict[str, dict],
) -> List[LicenseEntry]:
    node_modules = frontend_root / "node_modules"
    if not node_modules.exists():
        return []

    cmd = ["npm", "ls", "--json", "--production", "--long"]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(frontend_root),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        print("[collect-licenses] skip node packages: npm command not found")
        return []
    if not proc.stdout.strip():
        return []

    try:
        tree = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []

    collected: Dict[str, LicenseEntry] = {}

    def traverse(deps: Optional[dict]) -> None:
        if not deps:
            return
        for name, info in deps.items():
            version = info.get("version")
            if not version:
                continue
            key = f"{name.lower()}@{version}" if version else name.lower()
            if key in collected:
                traverse(info.get("dependencies"))
                continue
            pkg_json = _read_node_package_info(node_modules, name)
            if not pkg_json:
                # npm ls は node_modules が未解決の依存も列挙するため、情報がない場合はスキップ
                traverse(info.get("dependencies"))
                continue
            license_name = _extract_node_license(pkg_json)
            author = _author_to_str(pkg_json.get("author"))
            homepage = pkg_json.get("homepage")
            repository = pkg_json.get("repository")
            license_url = None
            if isinstance(repository, dict):
                license_url = repository.get("url")
            elif isinstance(repository, str):
                license_url = repository
            entry = LicenseEntry(
                name=name,
                version=version,
                license=license_name,
                text="",
                component="frontend",
                category="development" if info.get("dev") else "runtime",
                homepage=homepage,
                author=author,
                license_url=license_url,
                source="node",
            )
            fallback = (
                existing_lookup.get(f"{name.lower()}@{version}")
                or existing_lookup.get(name.lower())
            )
            if fallback:
                if not entry.license:
                    entry.license = fallback.get("license", "")
                if not entry.text:
                    entry.text = fallback.get("text", "")
                if not entry.homepage:
                    entry.homepage = fallback.get("homepage")
                if not entry.author:
                    entry.author = fallback.get("author")
                if not entry.license_url:
                    entry.license_url = fallback.get("license_url")
            collected[key] = entry
            traverse(info.get("dependencies"))

    traverse(tree.get("dependencies"))
    for item in list(existing_lookup.values()):
        if item.get("source") != "node":
            continue
        name = item.get("name")
        if not name:
            continue
        version = item.get("version") or ""
        key = f"{name.lower()}@{version}" if version else name.lower()
        if key in collected:
            entry = collected[key]
            if not entry.text and item.get("text"):
                entry.text = item.get("text", "")
            if not entry.license and item.get("license"):
                entry.license = item.get("license", "")
            if not entry.homepage and item.get("homepage"):
                entry.homepage = item.get("homepage")
            if not entry.author and item.get("author"):
                entry.author = item.get("author")
            if not entry.license_url and item.get("license_url"):
                entry.license_url = item.get("license_url")
            continue
        collected[key] = license_entry_from_dict(item)

    return list({id(entry): entry for entry in collected.values()}.values())


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    frontend_root = root / "frontend"

    out = root / "frontend" / "public" / "docs" / "dependency_licenses.json"
    existing_data = load_existing_data(out)
    existing_lookup = build_existing_lookup(existing_data)

    python_entries = collect_python_licenses(PYTHON_PACKAGES, existing_lookup)
    node_entries = collect_node_licenses(frontend_root, existing_lookup)

    combined = python_entries + node_entries
    # 任意の追加ライセンス情報（手動追記分）が existing_data にあれば統合
    manual_entries: List[LicenseEntry] = []
    for item in existing_data:
        tag = item.get("source")
        if tag not in {"python", "node"}:
            manual_entries.append(license_entry_from_dict(item))

    data = [asdict(entry) for entry in [*combined, *manual_entries]]

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} ({len(data)} entries)")


if __name__ == "__main__":
    main()

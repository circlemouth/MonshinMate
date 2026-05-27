"""Postal-code dictionary import and lookup helpers."""
from __future__ import annotations

import csv
import io
import os
import sqlite3
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, Any


POSTAL_DATA_DIR = Path(
    os.getenv(
        "MONSHINMATE_POSTAL_DATA_DIR",
        str(Path(__file__).resolve().parent / "postal_code_data"),
    )
)
POSTAL_DB_PATH = Path(
    os.getenv("MONSHINMATE_POSTAL_DB", str(POSTAL_DATA_DIR / "postal_codes.sqlite3"))
)
BUNDLED_POSTAL_CSV_PATH = POSTAL_DATA_DIR / "utf_ken_all.csv"

POSTAL_TABLE_SCHEMA = """
CREATE TABLE IF NOT EXISTS postal_codes (
    postal_code TEXT NOT NULL,
    prefecture TEXT NOT NULL,
    city TEXT NOT NULL,
    town TEXT NOT NULL,
    address TEXT NOT NULL
)
"""

POSTAL_META_SCHEMA = """
CREATE TABLE IF NOT EXISTS postal_code_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
"""


class PostalCodeImportError(ValueError):
    """Raised when the postal-code dictionary cannot be imported."""


def normalize_postal_code(value: str | None) -> str:
    """Return only ASCII digits from a postal-code-like value."""

    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value)
    return "".join(ch for ch in normalized if ch.isdigit())


def _connect(db_path: Path = POSTAL_DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_postal_db(db_path: Path = POSTAL_DB_PATH) -> None:
    with _connect(db_path) as conn:
        conn.execute(POSTAL_TABLE_SCHEMA)
        conn.execute(POSTAL_META_SCHEMA)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_postal_codes_postal_code ON postal_codes(postal_code)"
        )


def _build_address(prefecture: str, city: str, town: str) -> str:
    normalized_town = (town or "").strip()
    if normalized_town == "以下に掲載がない場合":
        normalized_town = ""
    return f"{prefecture.strip()}{city.strip()}{normalized_town}"


def _set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        """
        INSERT INTO postal_code_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (key, str(value)),
    )


def import_postal_csv(
    file_obj: BinaryIO,
    source_filename: str | None = None,
    db_path: Path = POSTAL_DB_PATH,
) -> dict[str, Any]:
    """Import a Japan Post KEN_ALL CSV into the local lookup database."""

    init_postal_db(db_path)
    text_stream = io.TextIOWrapper(file_obj, encoding="utf-8-sig", newline="")
    reader = csv.reader(text_stream)
    rows: list[tuple[str, str, str, str, str]] = []
    row_count = 0

    try:
        for row in reader:
            if len(row) < 9:
                continue
            postal_code = normalize_postal_code(row[2])
            if len(postal_code) != 7:
                continue
            prefecture = row[6].strip()
            city = row[7].strip()
            town = row[8].strip()
            if not prefecture or not city:
                continue
            address = _build_address(prefecture, city, town)
            rows.append((postal_code, prefecture, city, town, address))
            row_count += 1
    except UnicodeDecodeError as exc:
        raise PostalCodeImportError("CSVはUTF-8で保存されたものを指定してください") from exc
    except csv.Error as exc:
        raise PostalCodeImportError("CSVの読み込みに失敗しました") from exc

    if row_count == 0:
        raise PostalCodeImportError("郵便番号データが見つかりません")

    imported_at = datetime.now(UTC).isoformat()
    with _connect(db_path) as conn:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM postal_codes")
        conn.executemany(
            """
            INSERT INTO postal_codes (postal_code, prefecture, city, town, address)
            VALUES (?, ?, ?, ?, ?)
            """,
            rows,
        )
        _set_meta(conn, "row_count", row_count)
        _set_meta(conn, "source_filename", source_filename or "")
        _set_meta(conn, "last_updated_at", imported_at)
        conn.commit()

    return {
        "is_available": True,
        "row_count": row_count,
        "source_filename": source_filename or None,
        "last_updated_at": imported_at,
    }


def ensure_postal_dictionary(db_path: Path = POSTAL_DB_PATH) -> None:
    """Initialize lookup DB and import bundled CSV when no data exists yet."""

    init_postal_db(db_path)
    with _connect(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) AS count FROM postal_codes").fetchone()
        if row and int(row["count"] or 0) > 0:
            return
    if BUNDLED_POSTAL_CSV_PATH.exists():
        with BUNDLED_POSTAL_CSV_PATH.open("rb") as file_obj:
            import_postal_csv(file_obj, BUNDLED_POSTAL_CSV_PATH.name, db_path=db_path)


def get_postal_dictionary_info(db_path: Path = POSTAL_DB_PATH) -> dict[str, Any]:
    ensure_postal_dictionary(db_path)
    with _connect(db_path) as conn:
        row = conn.execute("SELECT COUNT(*) AS count FROM postal_codes").fetchone()
        meta_rows = conn.execute("SELECT key, value FROM postal_code_meta").fetchall()
    meta = {row["key"]: row["value"] for row in meta_rows}
    row_count = int(row["count"] or 0) if row else 0
    return {
        "is_available": row_count > 0,
        "row_count": row_count,
        "source_filename": meta.get("source_filename") or None,
        "last_updated_at": meta.get("last_updated_at"),
    }


def lookup_postal_code(postal_code: str, db_path: Path = POSTAL_DB_PATH) -> dict[str, Any]:
    normalized = normalize_postal_code(postal_code)
    if len(normalized) != 7:
        return {
            "postal_code": normalized,
            "found": False,
            "address": None,
            "candidates": [],
        }

    ensure_postal_dictionary(db_path)
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT postal_code, prefecture, city, town, address
            FROM postal_codes
            WHERE postal_code = ?
            ORDER BY prefecture, city, town
            LIMIT 20
            """,
            (normalized,),
        ).fetchall()

    candidates = [dict(row) for row in rows]
    address = candidates[0]["address"] if candidates else None
    return {
        "postal_code": normalized,
        "found": bool(candidates),
        "address": address,
        "candidates": candidates,
    }

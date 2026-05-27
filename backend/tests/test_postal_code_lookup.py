"""郵便番号辞書のインポートと検索のテスト。"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sys

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.postal_code_lookup import (  # type: ignore[import]
    PostalCodeImportError,
    get_postal_dictionary_info,
    import_postal_csv,
    lookup_postal_code,
)


SAMPLE_CSV = "\n".join(
    [
        '"01101","060  ","0600000","ホッカイドウ","サッポロシチュウオウク","イカニケイサイガナイバアイ","北海道","札幌市中央区","以下に掲載がない場合",0,0,0,0,0,0',
        '"13101","100  ","1000001","トウキョウト","チヨダク","チヨダ","東京都","千代田区","千代田",0,0,0,0,0,0',
    ]
)


def test_import_postal_csv_and_lookup(tmp_path: Path) -> None:
    db_path = tmp_path / "postal_codes.sqlite3"

    info = import_postal_csv(BytesIO(SAMPLE_CSV.encode("utf-8")), "sample.csv", db_path=db_path)

    assert info["is_available"] is True
    assert info["row_count"] == 2
    assert info["source_filename"] == "sample.csv"
    assert info["last_updated_at"]

    stored_info = get_postal_dictionary_info(db_path=db_path)
    assert stored_info["row_count"] == 2
    assert stored_info["source_filename"] == "sample.csv"

    result = lookup_postal_code("０６０-００００", db_path=db_path)
    assert result["found"] is True
    assert result["address"] == "北海道札幌市中央区"
    assert result["candidates"][0]["postal_code"] == "0600000"

    result = lookup_postal_code("100-0001", db_path=db_path)
    assert result["found"] is True
    assert result["address"] == "東京都千代田区千代田"


def test_lookup_invalid_postal_code_does_not_fail(tmp_path: Path) -> None:
    result = lookup_postal_code("123", db_path=tmp_path / "postal_codes.sqlite3")

    assert result == {
        "postal_code": "123",
        "found": False,
        "address": None,
        "candidates": [],
    }


def test_import_empty_csv_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(PostalCodeImportError):
        import_postal_csv(BytesIO(b""), "empty.csv", db_path=tmp_path / "postal_codes.sqlite3")

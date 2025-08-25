"""回答バリデーション用ユーティリティ。"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Sequence

from fastapi import HTTPException


class Validator:
    """問診回答の妥当性を検証する。"""

    @staticmethod
    def _find_item(items: Sequence[Any], item_id: str) -> Any | None:
        for it in items:
            attr_id = getattr(it, "id", None)
            if attr_id == item_id:
                return it
            if isinstance(it, dict) and it.get("id") == item_id:
                return it
        return None

    @staticmethod
    def validate_partial(items: Sequence[Any], answers: dict[str, Any]) -> None:
        """部分的な回答の型や選択肢を検証する。"""
        for key, value in answers.items():
            spec = Validator._find_item(items, key)
            if spec is None:
                continue
            item_type = getattr(spec, "type", spec.get("type") if isinstance(spec, dict) else None)
            options = getattr(spec, "options", spec.get("options") if isinstance(spec, dict) else None)
            if item_type in ("string", "text"):
                if not isinstance(value, str):
                    raise HTTPException(status_code=400, detail=f"{key} は文字列で入力してください")
            elif item_type == "number":
                try:
                    float(value)
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(status_code=400, detail=f"{key} は数値で入力してください") from exc
            elif item_type == "date":
                try:
                    datetime.fromisoformat(str(value))
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(status_code=400, detail=f"{key} は日付(YYYY-MM-DD)で入力してください") from exc
            elif item_type == "single":
                if not isinstance(value, str):
                    raise HTTPException(status_code=400, detail=f"{key} は単一選択です")
                if options and value not in list(options):
                    raise HTTPException(status_code=400, detail=f"{key} の値が不正です")
            elif item_type == "yesno":
                if not isinstance(value, str):
                    raise HTTPException(status_code=400, detail=f"{key} は YES/NO を選択してください")
                if value not in ("yes", "no"):
                    raise HTTPException(status_code=400, detail=f"{key} は yes/no のいずれかで入力してください")
            elif item_type == "multi":
                # 後方互換: 単一文字列が来た場合は [str] に正規化
                if isinstance(value, str):
                    answers[key] = [value]
                    value = answers[key]
                if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                    raise HTTPException(status_code=400, detail=f"{key} は複数選択の配列で入力してください")
                allow_freetext = (
                    getattr(spec, "allow_freetext", None)
                    if not isinstance(spec, dict)
                    else spec.get("allow_freetext")
                ) or False
                if options:
                    invalid = [v for v in value if v not in list(options)]
                    if invalid and not allow_freetext:
                        raise HTTPException(status_code=400, detail=f"{key} の選択肢に不正な値があります")
                    if invalid and allow_freetext and any(not v.strip() for v in invalid):
                        raise HTTPException(status_code=400, detail=f"{key} の自由記述が不正です")

    @staticmethod
    def missing_required(items: Sequence[Any], answers: dict[str, Any]) -> list[str]:
        """未入力の必須項目ID一覧を返す。"""
        missing: list[str] = []
        for it in items:
            item_id = getattr(it, "id", None) if not isinstance(it, dict) else it.get("id")
            required = (it.get("required", False) if isinstance(it, dict) else getattr(it, "required", False))
            if not required:
                continue
            val = answers.get(item_id)
            if val is None or (isinstance(val, str) and not val.strip()) or (
                isinstance(val, list) and not val
            ):
                missing.append(item_id)
        return missing

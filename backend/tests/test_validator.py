"""Validator ユーティリティのテスト。"""
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.validator import Validator  # type: ignore
from app.main import QuestionnaireItem  # type: ignore


def test_validate_number() -> None:
    items = [QuestionnaireItem(id="age", label="年齢", type="number", required=False)]
    Validator.validate_partial(items, {"age": 30})
    with pytest.raises(HTTPException):
        Validator.validate_partial(items, {"age": "thirty"})


def test_validate_date() -> None:
    items = [QuestionnaireItem(id="visit", label="受診日", type="date", required=False)]
    Validator.validate_partial(items, {"visit": "2024-01-30"})
    with pytest.raises(HTTPException):
        Validator.validate_partial(items, {"visit": "2024-02-30"})


def test_missing_required() -> None:
    items = [QuestionnaireItem(id="cc", label="主訴", type="string", required=True)]
    missing = Validator.missing_required(items, {})
    assert missing == ["cc"]
    missing2 = Validator.missing_required(items, {"cc": "頭痛"})
    assert missing2 == []


def test_validate_multi_freetext() -> None:
    items = [
        QuestionnaireItem(
            id="symptoms",
            label="症状",
            type="multi",
            options=["咳", "頭痛"],
            allow_freetext=True,
        )
    ]
    Validator.validate_partial(items, {"symptoms": ["咳", "その他"]})
    items_no_free = [
        QuestionnaireItem(
            id="symptoms",
            label="症状",
            type="multi",
            options=["咳", "頭痛"],
            allow_freetext=False,
        )
    ]
    with pytest.raises(HTTPException):
        Validator.validate_partial(items_no_free, {"symptoms": ["咳", "その他"]})

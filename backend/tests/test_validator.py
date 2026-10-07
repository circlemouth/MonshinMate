"""Validator ユーティリティのテスト。"""
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.validator import Validator  # type: ignore
from app.main import QuestionnaireItem, Session  # type: ignore
from app import db
from app.db.sqlite_adapter import SQLiteAdapter
from app.session_fsm import SessionFSM


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    adapter = SQLiteAdapter(str(tmp_path / "synthetic.sqlite3"))
    adapter.init()
    monkeypatch.setattr(db, "_adapter", adapter)


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


@pytest.mark.parametrize("key", ["unknown", "llm_1", "summary", "completion_status"])
def test_unknown_answer_keys_are_rejected(key) -> None:
    items = [QuestionnaireItem(id="cc", label="主訴", type="string")]
    with pytest.raises(HTTPException) as error:
        Validator.validate_partial(items, {key: "未発行の回答"})
    assert error.value.status_code == 422


@pytest.mark.parametrize("as_model", [False, True])
def test_nested_followup_items_are_still_validated(as_model) -> None:
    specification = {
        "id": "symptom", "label": "症状", "type": "yesno",
        "followups": {"yes": [{"id": "detail", "label": "詳細", "type": "string"}]},
    }
    items = [QuestionnaireItem(**specification) if as_model else specification]
    Validator.validate_partial(items, {"detail": "頭痛"})
    with pytest.raises(HTTPException) as error:
        Validator.validate_partial(items, {"detail": 123})
    assert error.value.status_code == 400


@pytest.mark.parametrize("answers", [
    {"cc": "x" * 4001},
    {"cc": ["x"] * 101},
    {str(index): "x" for index in range(201)},
    {"x" * 129: "x"},
    {"cc": {"a": {"b": {"c": {"d": {"e": {"f": "deep"}}}}}}},
    {"cc": float("nan")},
    {"cc": float("inf")},
])
def test_answer_shape_is_bounded(answers) -> None:
    with pytest.raises(HTTPException) as error:
        Validator.validate_shape(answers)
    assert error.value.status_code == 422


def test_total_answer_bytes_are_bounded() -> None:
    with pytest.raises(HTTPException) as error:
        Validator.validate_shape({str(index): "あ" * 4000 for index in range(30)})
    assert error.value.status_code == 413


def test_followup_provider_failure_never_logs_payload(caplog) -> None:
    from types import SimpleNamespace

    class FailingGateway:
        settings = SimpleNamespace(enabled=True)

        def generate_followups(self, **kwargs):
            raise RuntimeError("SYNTHETIC-PATIENT-PROVIDER-SECRET")

    session = Session(
        id="synthetic-failure", patient_name="合成患者", dob="2000-01-01",
        gender="female", visit_type="initial", questionnaire_id="default",
        template_items=[], answers={}, max_additional_questions=1,
    )
    assert SessionFSM(session, FailingGateway()).next_question() is None
    assert "generate_followups_failed" in caplog.text
    assert "SYNTHETIC-PATIENT-PROVIDER-SECRET" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_issued_llm_question_is_required_and_finalized_answers_are_immutable() -> None:
    session = Session(
        id="synthetic-session", patient_name="合成患者", dob="2000-01-01",
        gender="female", visit_type="initial", questionnaire_id="default",
        template_items=[], answers={},
    )
    fsm = SessionFSM(session, None)
    # IDの接頭辞や一般の質問文マップだけではLLM質問の発行を証明しない。
    session.question_texts["llm_1"] = "未発行の質問"
    with pytest.raises(HTTPException) as error:
        fsm.step("llm_1", "回答")
    assert error.value.status_code == 422
    assert session.answers == {}

    session.llm_question_texts["llm_1"] = "発行済み質問"
    session.question_texts["llm_1"] = "発行済み質問"
    fsm.step("llm_1", "発行済み質問への回答")
    assert session.answers == {"llm_1": "発行済み質問への回答"}
    with pytest.raises(HTTPException) as error:
        fsm.step("llm_1", {"injected": "object"})
    assert error.value.status_code == 400

    session.completion_status = "finalized"
    with pytest.raises(HTTPException) as error:
        fsm.step("llm_1", "上書き")
    assert error.value.status_code == 409
    assert session.answers == {"llm_1": "発行済み質問への回答"}

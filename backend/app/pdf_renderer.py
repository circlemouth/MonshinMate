"""PDFレンダリングユーティリティ。

問診結果のPDFを構造化レイアウトで生成するための補助関数を提供する。
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Mapping, Sequence, TYPE_CHECKING

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    Flowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from xml.sax.saxutils import escape

from .personal_info import (
    FIELD_DEFS as PERSONAL_INFO_FIELDS,
    coerce_to_strings as personal_info_coerce,
    has_any_value as personal_info_has_any,
    EMPTY_PLACEHOLDER as PERSONAL_INFO_EMPTY,
    NORMALIZED_EMPTY as PERSONAL_INFO_NORMALIZED,
)

if TYPE_CHECKING:  # pragma: no cover - 型チェック専用
    from .main import QuestionnaireItem


class PDFLayoutMode(str, Enum):
    """PDFレイアウトの切り替えモード。"""

    STRUCTURED = "structured"
    LEGACY = "legacy"


@dataclass
class FollowupCondition:
    """親質問と選択肢を表す条件。"""

    parent_label: str
    option_label: str


@dataclass
class ItemNode:
    """PDF出力用に整形した問診項目。"""

    item: Any
    depth: int = 0
    condition: FollowupCondition | None = None


_JP_FONTS_REGISTERED = False


def ensure_japanese_fonts() -> None:
    """日本語フォントを一度だけ登録する。"""

    global _JP_FONTS_REGISTERED
    if _JP_FONTS_REGISTERED:
        return
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    _JP_FONTS_REGISTERED = True


def _item_attr(item: Any, name: str, default: Any = None) -> Any:
    if hasattr(item, name):
        return getattr(item, name)
    if isinstance(item, dict):
        return item.get(name, default)
    return default


def _flatten_items(items: Sequence[Any] | None, depth: int = 0) -> list[ItemNode]:
    """問診項目と追質問を木構造から一次元リストへ展開する。"""

    result: list[ItemNode] = []
    if not items:
        return result
    for it in items:
        result.append(ItemNode(item=it, depth=depth, condition=None))
        followups = _item_attr(it, "followups") or {}
        if isinstance(followups, dict):
            for opt, children in followups.items():
                condition = FollowupCondition(
                    parent_label=str(_item_attr(it, "label", "")),
                    option_label=str(opt),
                )
                result.extend(_flatten_followup(children, depth + 1, condition))
    return result


def _flatten_followup(
    children: Sequence[Any] | None, depth: int, condition: FollowupCondition
) -> list[ItemNode]:
    result: list[ItemNode] = []
    if not children:
        return result
    for child in children:
        node = ItemNode(item=child, depth=depth, condition=condition)
        result.append(node)
        followups = _item_attr(child, "followups") or {}
        if isinstance(followups, dict):
            for opt, grand_children in followups.items():
                new_condition = FollowupCondition(
                    parent_label=str(_item_attr(child, "label", "")),
                    option_label=str(opt),
                )
                result.extend(_flatten_followup(grand_children, depth + 1, new_condition))
    return result


def _has_answer(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        stripped = value.strip()
        return bool(stripped) or value in {"0", "0.0"}
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, dict):
        if personal_info_coerce(value) is not None:
            return personal_info_has_any(value)
        return bool(value)
    if isinstance(value, list):
        filtered = [v for v in value if isinstance(v, (str, int, float)) and str(v).strip()]
        return bool(filtered)
    return True


def _format_gender(gender: str | None) -> str:
    mapping = {"male": "男性", "female": "女性"}
    if not gender:
        return "未設定"
    return mapping.get(gender, str(gender))


def _format_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        dt = datetime.fromisoformat(str(value))
        return dt.strftime("%Y年%m月%d日")
    except Exception:  # noqa: BLE001 - 解析失敗時はそのまま返す
        return str(value)


def _resolve_completion_date(session: Mapping[str, Any]) -> str:
    """Return a formatted completion date text for header display."""

    candidate_keys = ("completed_at", "completedAt", "finalized_at", "finalizedAt")
    for key in candidate_keys:
        value = session.get(key)
        if not value:
            continue
        text = _format_date(str(value))
        if text:
            return text
    fallback_keys = ("started_at", "startedAt")
    for key in fallback_keys:
        value = session.get(key)
        if not value:
            continue
        text = _format_date(str(value))
        if text:
            return text
    return ""


def _create_styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle(
        name="Base",
        fontName="HeiseiMin-W3",
        fontSize=10,
        leading=14,
        spaceAfter=0,
        spaceBefore=0,
    )
    styles = {
        "base": base,
        "bold": ParagraphStyle(
            name="Bold",
            parent=base,
            fontName="HeiseiKakuGo-W5",
        ),
        "title": ParagraphStyle(
            name="Title",
            parent=base,
            fontName="HeiseiKakuGo-W5",
            fontSize=16,
            leading=20,
            alignment=TA_CENTER,
        ),
        "section": ParagraphStyle(
            name="Section",
            parent=base,
            fontName="HeiseiKakuGo-W5",
            fontSize=12,
            leading=16,
            spaceBefore=4,
            spaceAfter=4,
        ),
        "header_left": ParagraphStyle(
            name="HeaderLeft",
            parent=base,
            fontName="HeiseiKakuGo-W5",
            fontSize=14,
            leading=18,
        ),
        "header_right": ParagraphStyle(
            name="HeaderRight",
            parent=base,
            fontSize=9,
            alignment=TA_RIGHT,
            leading=12,
        ),
        "note": ParagraphStyle(
            name="Note",
            parent=base,
            fontSize=8,
            textColor=colors.grey,
            leading=10,
        ),
        "value": ParagraphStyle(
            name="Value",
            parent=base,
            leading=14,
        ),
    }
    return styles


_LABEL_STYLE_CACHE: dict[int, ParagraphStyle] = {}


def _label_style_for_depth(depth: int, base_style: ParagraphStyle) -> ParagraphStyle:
    style = _LABEL_STYLE_CACHE.get(depth)
    if style:
        return style
    style = ParagraphStyle(
        name=f"LabelDepth{depth}",
        parent=base_style,
        leftIndent=depth * 6 * mm,
        leading=base_style.leading,
    )
    _LABEL_STYLE_CACHE[depth] = style
    return style


def _make_label_paragraph(
    node: ItemNode,
    styles: dict[str, ParagraphStyle],
) -> Paragraph:
    label_text = escape(str(_item_attr(node.item, "label", node.item)))
    if node.condition:
        note = (
            f"<br/><font size=8 color='#555555'>（{escape(node.condition.parent_label)}"
            f"で「{escape(node.condition.option_label)}」選択時）</font>"
        )
    else:
        note = ""
    style = _label_style_for_depth(node.depth, styles["bold"])
    return Paragraph(label_text + note, style)


def _make_value_flowable(
    node: ItemNode,
    answer: Any,
    styles: dict[str, ParagraphStyle],
    value_width: float,
) -> Flowable:
    item_type = str(_item_attr(node.item, "type", "string") or "string")
    if item_type == "multi":
        return _render_multi_answer(node, answer, styles, value_width)
    if item_type == "yesno":
        return _render_yesno_answer(answer, styles)
    if item_type in {"number", "slider"}:
        return _render_number_answer(answer, styles, value_width)
    if item_type == "date":
        return _render_date_answer(answer, styles, value_width)
    if item_type == "personal_info":
        return _render_personal_info_answer(answer, styles, value_width)
    return _render_text_answer(answer, styles, value_width)


def _normalize_multi_answer(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str):
        if not value.strip():
            return []
        return [value]
    return [str(value)]


def _render_multi_answer(
    node: ItemNode,
    answer: Any,
    styles: dict[str, ParagraphStyle],
    value_width: float,
) -> Flowable:
    options = _item_attr(node.item, "options") or []
    if isinstance(options, tuple):
        options = list(options)
    options = [str(opt) for opt in options]
    selected_values = _normalize_multi_answer(answer)
    if not options:
        text = ", ".join(selected_values) if selected_values else "未回答"
        return _render_text_answer(text, styles, value_width)

    option_set = set(options)
    selected_set = {val for val in selected_values if val in option_set}
    selected_options = [opt for opt in options if opt in selected_set]
    free_text_values = [opt for opt in selected_values if opt not in option_set]

    lines: list[str] = []
    for opt in selected_options:
        lines.append(f"・{escape(opt)}")
    for val in free_text_values:
        formatted = escape(val).replace("\n", "<br/>")
        lines.append(f"・自由記述: {formatted}")

    if not lines:
        return Paragraph("未回答", styles["value"])

    text = "<br/>".join(lines)
    return Paragraph(text, styles["value"])


def _render_yesno_answer(answer: Any, styles: dict[str, ParagraphStyle]) -> Flowable:
    value = str(answer or "").strip()
    if not value:
        return Paragraph("未回答", styles["value"])
    normalized = value.lower()
    if normalized == "yes":
        display = "はい"
    elif normalized == "no":
        display = "いいえ"
    else:
        display = value
    return Paragraph(escape(display), styles["value"])


def _render_number_answer(answer: Any, styles: dict[str, ParagraphStyle], value_width: float) -> Flowable:
    text = "未回答" if answer is None or str(answer).strip() == "" else str(answer)
    table = Table([[Paragraph(escape(text), styles["value"])]] , colWidths=[value_width])
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _render_personal_info_answer(
    answer: Any,
    styles: dict[str, ParagraphStyle],
    value_width: float,
) -> Flowable:
    data = personal_info_coerce(answer)
    if data is None:
        return _render_text_answer(answer, styles, value_width)
    rows: list[list[Paragraph]] = []
    for key, label in PERSONAL_INFO_FIELDS:
        text = data[key].strip()
        display_text = text if text and text != PERSONAL_INFO_NORMALIZED else PERSONAL_INFO_EMPTY
        display = escape(display_text)
        rows.append(
            [
                Paragraph(f"<b>{escape(label)}</b>", styles["base"]),
                Paragraph(display.replace("\n", "<br/>"), styles["value"]),
            ]
        )
    label_col = min(42 * mm, value_width * 0.4)
    table = Table(
        rows,
        colWidths=[label_col, max(value_width - label_col, value_width * 0.5)],
        hAlign="LEFT",
    )
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.3, colors.grey),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0f0f0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return table


def _collect_personal_info_for_header(
    nodes: Sequence[ItemNode],
    answers: Mapping[str, Any],
) -> tuple[list[ItemNode], dict[str, str]]:
    filtered_nodes: list[ItemNode] = []
    collected: dict[str, str] = {}
    for node in nodes:
        item_type = str(_item_attr(node.item, "type", "") or "")
        if item_type != "personal_info":
            filtered_nodes.append(node)
            continue
        item_id_raw = _item_attr(node.item, "id")
        if item_id_raw is None:
            continue
        item_id = str(item_id_raw)
        answer_value = answers.get(item_id)
        if answer_value is None and item_id_raw != item_id:
            try:
                answer_value = answers.get(item_id_raw)  # type: ignore[arg-type]
            except Exception:  # pragma: no cover - defensive fallback
                answer_value = None
        data = personal_info_coerce(answer_value)
        if data is None:
            continue
        for key, value in data.items():
            text = value.strip()
            if not text or text == PERSONAL_INFO_NORMALIZED:
                continue
            if key not in collected or not collected[key].strip():
                collected[key] = text
    return filtered_nodes, collected


def _personal_info_header_value(values: Mapping[str, str], key: str) -> str:
    text = values.get(key, "").strip()
    if not text or text == PERSONAL_INFO_NORMALIZED:
        return PERSONAL_INFO_EMPTY
    return text


def _render_date_answer(answer: Any, styles: dict[str, ParagraphStyle], value_width: float) -> Flowable:
    text = _format_date(str(answer) if answer else None) or "未回答"
    table = Table([[Paragraph(escape(text), styles["value"])]] , colWidths=[value_width])
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _render_text_answer(answer: Any, styles: dict[str, ParagraphStyle], value_width: float) -> Flowable:
    del value_width  # 内側テーブルを使用しないため未使用

    def _format_text(value: str) -> str:
        return escape(value).replace("\n", "<br/>")

    rendered = "未回答"
    if isinstance(answer, str):
        stripped = answer.strip()
        if stripped:
            rendered = _format_text(answer)
    elif isinstance(answer, list):
        formatted_items = [_format_text(str(v)) for v in answer if str(v).strip()]
        if formatted_items:
            rendered = "<br/>".join(formatted_items)
    elif isinstance(answer, (int, float)):
        rendered = escape(str(answer))
    elif answer not in (None, ""):
        rendered = _format_text(str(answer))

    return Paragraph(rendered or "未回答", styles["value"])


def _make_question_table(
    nodes: list[ItemNode],
    answers: Mapping[str, Any],
    styles: dict[str, ParagraphStyle],
    doc_width: float,
) -> Table | None:
    if not nodes:
        return None
    label_width = 55 * mm
    value_width = doc_width - label_width
    data: list[list[Any]] = []
    for node in nodes:
        item_id = _item_attr(node.item, "id")
        if not item_id:
            continue
        value = answers.get(item_id)
        if node.condition and not _has_answer(value):
            continue
        label_para = _make_label_paragraph(node, styles)
        value_flow = _make_value_flowable(node, value, styles, value_width)
        data.append([label_para, value_flow])
    if not data:
        return None
    table = Table(data, colWidths=[label_width, value_width], repeatRows=0, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f7f7f7")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _make_llm_table(
    llm_question_texts: Mapping[str, str],
    answers: Mapping[str, Any],
    styles: dict[str, ParagraphStyle],
    doc_width: float,
) -> Table | None:
    if not llm_question_texts:
        return None
    label_width = 55 * mm
    value_width = doc_width - label_width
    rows: list[list[Any]] = []
    for key, text in llm_question_texts.items():
        label_para = Paragraph(escape(str(text)), styles["bold"])
        value_flow = _render_text_answer(answers.get(key), styles, value_width)
        rows.append([label_para, value_flow])
    if not rows:
        return None
    table = Table(rows, colWidths=[label_width, value_width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0f0f0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _make_summary_box(summary: str, styles: dict[str, ParagraphStyle], width: float) -> Table:
    text = escape(summary).replace("\n", "<br/>")
    para = Paragraph(text, styles["value"])
    table = Table([[para]], colWidths=[width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _render_structured_pdf(
    session: Mapping[str, Any],
    rows: Sequence[tuple[str, str]],
    template_items: Sequence[QuestionnaireItem | dict[str, Any]],
    answers: Mapping[str, Any],
    vt_label: str,
    llm_question_texts: Mapping[str, str],
    summary: str | None,
    facility_name: str,
) -> bytes:
    ensure_japanese_fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
    )
    styles = _create_styles()
    story: list[Flowable] = []

    completion_display = _resolve_completion_date(session) or "未登録"
    header = Table(
        [
            [
                Paragraph(escape(facility_name), styles["header_left"]),
                Paragraph(
                    f"問診票記入日: {escape(completion_display)}",
                    styles["header_right"],
                ),
            ],
        ],
        colWidths=[doc.width * 0.55, doc.width * 0.45],
        hAlign="LEFT",
    )
    header.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story.append(header)
    story.append(Spacer(0, 4 * mm))
    # 表題に受診種別を併記（例: 問診票（再診））
    title_label = "問診票"
    if vt_label:
        title_label = f"{title_label}（{vt_label}）"
    story.append(Paragraph(escape(title_label), styles["title"]))
    story.append(Spacer(0, 5 * mm))

    nodes = _flatten_items(template_items)
    question_nodes, personal_info_values = _collect_personal_info_for_header(nodes, answers)

    # 受診種別欄は削除
    name_text = session.get("patient_name") or "未登録"
    kana_text = _personal_info_header_value(personal_info_values, "kana")
    dob_text = _format_date(session.get("dob")) or "未登録"
    gender_text = _format_gender(session.get("gender"))
    postal_code_text = _personal_info_header_value(personal_info_values, "postal_code")
    address_text = _personal_info_header_value(personal_info_values, "address")
    phone_text = _personal_info_header_value(personal_info_values, "phone")

    def _label_cell(text: str) -> Paragraph:
        return Paragraph(f"<b>{escape(text)}</b>", styles["base"])

    def _value_cell(text: str) -> Paragraph:
        display = text if text else PERSONAL_INFO_EMPTY
        return Paragraph(escape(display).replace("\n", "<br/>"), styles["value"])

    kana_line = kana_text if kana_text and kana_text != PERSONAL_INFO_EMPTY else "未回答"
    kana_color = "#888888" if kana_text == PERSONAL_INFO_EMPTY else "#555555"
    name_markup = (
        f"<font size=8 color='{kana_color}'>{escape(kana_line)}</font>"
        f"<br/><font size=12>{escape(name_text)}</font>"
    )

    label_width = 28 * mm
    remaining_width = doc.width - (label_width * 2)
    left_value_width = remaining_width * 0.4
    right_value_width = remaining_width - left_value_width

    patient_table_data = [
        [
            _label_cell("患者氏名"),
            Paragraph(name_markup, styles["value"]),
            _label_cell("生年月日"),
            _value_cell(dob_text),
        ],
        [
            _label_cell("性別"),
            _value_cell(gender_text),
            _label_cell("電話番号"),
            _value_cell(phone_text),
        ],
        [
            _label_cell("郵便番号"),
            _value_cell(postal_code_text),
            _label_cell("住所"),
            _value_cell(address_text),
        ],
    ]

    patient_table = Table(
        patient_table_data,
        colWidths=[label_width, left_value_width, label_width, right_value_width],
        hAlign="LEFT",
    )
    patient_table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, colors.black),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d6dde3")),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f5f7fa")),
                ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f5f7fa")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (1, 0), (1, 0), 10),
            ]
        )
    )
    story.append(patient_table)
    story.append(Spacer(0, 6 * mm))

    story.append(Paragraph("問診回答", styles["section"]))
    question_table = _make_question_table(question_nodes, answers, styles, doc.width)
    if question_table:
        story.append(question_table)
    else:
        story.append(Paragraph("回答は記録されていません。", styles["value"]))

    llm_table = _make_llm_table(llm_question_texts, answers, styles, doc.width)
    if llm_table:
        story.append(Spacer(0, 6 * mm))
        story.append(Paragraph("追加質問", styles["section"]))
        story.append(llm_table)

    if summary:
        story.append(Spacer(0, 6 * mm))
        story.append(Paragraph("自動生成サマリー", styles["section"]))
        story.append(_make_summary_box(summary, styles, doc.width))

    doc.build(story)
    buf.seek(0)
    return buf.getvalue()


def _render_legacy_pdf(
    session: Mapping[str, Any],
    rows: Sequence[tuple[str, str]],
    vt_label: str,
    summary: str | None,
    facility_name: str,
) -> bytes:
    ensure_japanese_fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=40,
        rightMargin=40,
        topMargin=40,
        bottomMargin=40,
    )
    styles = _create_styles()
    story: list[Flowable] = []

    completion_display = _resolve_completion_date(session) or "未登録"
    header = Table(
        [
            [
                Paragraph(f"<b>{escape(facility_name)}</b>", styles["header_left"]),
                Paragraph(f"問診票記入日: {escape(completion_display)}", styles["header_right"]),
            ]
        ],
        colWidths=[doc.width * 0.55, doc.width * 0.45],
        hAlign="LEFT",
    )
    header.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story.append(header)
    story.append(Spacer(0, 4 * mm))
    # 表題に受診種別を併記（例: 問診結果（再診））
    legacy_title = "問診結果"
    if vt_label:
        legacy_title = f"{legacy_title}（{vt_label}）"
    story.append(Paragraph(escape(legacy_title), styles["title"]))
    story.append(Spacer(0, 6 * mm))
    story.append(Paragraph("患者情報", styles["section"]))
    # 受診種別の行は削除し、タイトルへ併記
    info_lines = [
        f"患者名: {escape(session.get('patient_name') or '未登録')}",
        f"生年月日: {escape(_format_date(session.get('dob')) or '未登録')}",
        f"性別: {escape(_format_gender(session.get('gender')))}",
    ]
    for line in info_lines:
        story.append(Paragraph(line, styles["value"]))

    story.append(Spacer(0, 6 * mm))
    story.append(Paragraph("回答", styles["section"]))
    if rows:
        for label, value in rows:
            text = f"<b>{escape(label)}</b>: {escape(value or '未回答')}"
            story.append(Paragraph(text, styles["value"]))
    else:
        story.append(Paragraph("回答は記録されていません。", styles["value"]))

    if summary:
        story.append(Spacer(0, 6 * mm))
        story.append(Paragraph("自動生成サマリー", styles["section"]))
        story.append(Paragraph(escape(summary).replace("\n", "<br/>"), styles["value"]))

    doc.build(story)
    buf.seek(0)
    return buf.getvalue()


def render_session_pdf(
    session: Mapping[str, Any],
    rows: Sequence[tuple[str, str]],
    template_items: Sequence[QuestionnaireItem | dict[str, Any]],
    answers: Mapping[str, Any],
    vt_label: str,
    llm_question_texts: Mapping[str, str] | None,
    summary: str | None,
    layout_mode: PDFLayoutMode,
    facility_name: str,
) -> bytes:
    """問診結果PDFを指定レイアウトで生成する。"""

    llm_texts = llm_question_texts or {}
    if layout_mode == PDFLayoutMode.LEGACY:
        return _render_legacy_pdf(session, rows, vt_label, summary, facility_name)
    return _render_structured_pdf(
        session,
        rows,
        template_items,
        answers,
        vt_label,
        llm_texts,
        summary,
        facility_name,
    )

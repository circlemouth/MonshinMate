from __future__ import annotations

import io
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from xml.sax.saxutils import escape


MINCHO_FONT = "HeiseiMin-W3"
GOTHIC_FONT = "HeiseiKakuGo-W5"


@dataclass
class ExportQuestion:
    """PDF出力用に整形した問診項目の情報。"""

    id: str
    label: str
    type: str
    answer: Any
    options: list[str]
    allow_freetext: bool = False
    description: str | None = None
    source: str = "base"

    def formatted_answer(self) -> str:
        """CSV/Markdown向けにシンプルな文字列へ変換する。"""

        if self.answer is None:
            return ""
        if isinstance(self.answer, str):
            return self.answer
        if isinstance(self.answer, list):
            return ", ".join(map(str, self.answer))
        if isinstance(self.answer, dict):
            return json.dumps(self.answer, ensure_ascii=False)
        return str(self.answer)


def ensure_fonts_registered() -> None:
    """日本語フォントを一度だけ登録する。"""

    for font_name in (MINCHO_FONT, GOTHIC_FONT):
        try:
            pdfmetrics.getFont(font_name)
        except KeyError:
            pdfmetrics.registerFont(UnicodeCIDFont(font_name))


def _iter_template_items(
    items: Sequence[dict[str, Any]],
    answers: dict[str, Any],
) -> Iterable[dict[str, Any]]:
    """テンプレート項目を順序通りに走査し、回答が存在する追質問も含めて返す。"""

    for item in items or []:
        if not isinstance(item, dict):
            continue
        yield item
        followups = item.get("followups") or {}
        if not isinstance(followups, dict):
            continue
        for flist in followups.values():
            if not isinstance(flist, list):
                continue
            sub_items = [sub for sub in flist if isinstance(sub, dict)]
            if not sub_items:
                continue
            # 回答が存在する追質問のみ展開する
            if any(sub.get("id") in answers for sub in sub_items):
                yield from _iter_template_items(sub_items, answers)


def build_export_questions(
    template: dict[str, Any] | None,
    answers: dict[str, Any] | None,
    llm_question_texts: dict[str, str] | None,
) -> tuple[list[ExportQuestion], list[ExportQuestion]]:
    """テンプレート情報と回答からPDF出力用の項目リストを生成する。"""

    answers = answers or {}
    llm_question_texts = llm_question_texts or {}
    items = template.get("items") if template else []

    base_questions: list[ExportQuestion] = []
    for item in _iter_template_items(items or [], answers):
        qid = item.get("id")
        if not qid:
            continue
        label = item.get("label") or str(qid)
        q_type = item.get("type") or "text"
        options = item.get("options") if isinstance(item.get("options"), list) else []
        base_questions.append(
            ExportQuestion(
                id=str(qid),
                label=str(label),
                type=str(q_type),
                answer=answers.get(qid),
                options=[str(opt) for opt in options],
                allow_freetext=bool(item.get("allow_freetext")),
                description=item.get("description"),
                source="base",
            )
        )

    llm_questions: list[ExportQuestion] = []
    for qid, text in llm_question_texts.items():
        llm_questions.append(
            ExportQuestion(
                id=str(qid),
                label=str(text),
                type="text",
                answer=answers.get(qid),
                options=[],
                allow_freetext=True,
                description=None,
                source="llm",
            )
        )

    return base_questions, llm_questions


def _build_label_paragraph(question: ExportQuestion, style: ParagraphStyle) -> Paragraph:
    lines = [escape(question.label)]
    if question.description:
        lines.append(f"<font size='9' color='#666666'>{escape(str(question.description))}</font>")
    return Paragraph("<br/>".join(lines), style)


def _format_checkbox_lines(options: list[str], selected: list[str]) -> list[str]:
    lines: list[str] = []
    for opt in options:
        mark = "■" if opt in selected else "□"
        lines.append(f"{mark} {escape(opt)}")
    extras = [opt for opt in selected if opt not in options]
    if extras:
        lines.append(f"記述: {escape(', '.join(extras))}")
    return lines


def _format_answer_paragraph(question: ExportQuestion, style: ParagraphStyle) -> Paragraph:
    value = question.answer
    if value is None or (isinstance(value, str) and not value.strip()) or (
        isinstance(value, list) and not value
    ):
        return Paragraph("未回答", style)

    if question.type == "multi":
        selected = [str(v) for v in value] if isinstance(value, list) else [str(value)]
        lines = _format_checkbox_lines(question.options, selected)
        return Paragraph("<br/>".join(lines), style)

    if question.type == "yesno":
        normalized = str(value).lower()
        lines = [
            f"{'■' if normalized == 'yes' else '□'} はい",
            f"{'■' if normalized == 'no' else '□'} いいえ",
        ]
        return Paragraph("<br/>".join(lines), style)

    if isinstance(value, list):
        text = ", ".join(map(str, value))
    elif isinstance(value, dict):
        text = json.dumps(value, ensure_ascii=False)
    else:
        text = str(value)
    return Paragraph(escape(text).replace("\n", "<br/>"), style)


def render_structured_pdf(
    session: dict[str, Any],
    vt_label: str,
    base_questions: Sequence[ExportQuestion],
    llm_questions: Sequence[ExportQuestion],
    facility_name: str,
    downloaded_at: datetime | None = None,
) -> bytes:
    """構造化レイアウトの問診票PDFを生成する。"""

    ensure_fonts_registered()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=22 * mm,
        bottomMargin=18 * mm,
    )

    styles = getSampleStyleSheet()
    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName=MINCHO_FONT,
        fontSize=10.5,
        leading=13.5,
    )
    label_style = ParagraphStyle(
        "Label",
        parent=styles["Normal"],
        fontName=GOTHIC_FONT,
        fontSize=10.5,
        leading=13.5,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName=GOTHIC_FONT,
        fontSize=13,
        leading=16,
        spaceBefore=12,
        spaceAfter=4,
    )
    title_style = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName=GOTHIC_FONT,
        fontSize=16,
        leading=20,
        spaceAfter=6,
    )
    meta_style = ParagraphStyle(
        "Meta",
        parent=body_style,
        fontSize=9,
        leading=11,
        textColor=colors.HexColor("#555555"),
    )

    elements: list[Any] = []
    facility = facility_name or "Monshinクリニック"
    elements.append(Paragraph(f"{escape(facility)} 問診票", title_style))

    issued = (downloaded_at or datetime.now()).strftime("%Y-%m-%d %H:%M")
    meta_lines = [
        f"受診種別: {escape(vt_label)}",
        f"出力日時: {escape(issued)}",
    ]
    finalized = session.get("finalized_at")
    if finalized:
        meta_lines.append(f"確定日時: {escape(str(finalized))}")
    if session.get("id"):
        meta_lines.append(f"セッションID: {escape(str(session['id']))}")
    elements.append(Paragraph("<br/>".join(meta_lines), meta_style))
    elements.append(Spacer(1, 6))

    patient_rows: list[list[Paragraph]] = []
    gender_map = {"male": "男性", "female": "女性"}
    patient_fields = [
        ("患者名", session.get("patient_name") or ""),
        ("生年月日", session.get("dob") or ""),
        ("性別", gender_map.get(str(session.get("gender")), session.get("gender") or "")),
        ("テンプレートID", session.get("questionnaire_id") or ""),
    ]
    for label, value in patient_fields:
        display = str(value) if value else "未入力"
        patient_rows.append(
            [
                Paragraph(f"<b>{escape(label)}</b>", label_style),
                Paragraph(escape(display), body_style),
            ]
        )
    patient_table = Table(patient_rows, colWidths=[32 * mm, 120 * mm])
    patient_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#b0b0b0")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    elements.append(patient_table)

    if base_questions:
        elements.append(Paragraph("問診回答", section_style))
        question_rows: list[list[Any]] = []
        for question in base_questions:
            question_rows.append(
                [
                    _build_label_paragraph(question, label_style),
                    _format_answer_paragraph(question, body_style),
                ]
            )
        question_table = Table(question_rows, colWidths=[60 * mm, None])
        question_table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#8a8a8a")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#b0b0b0")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        elements.append(question_table)

    if llm_questions:
        elements.append(Paragraph("追加入力（LLM生成）", section_style))
        llm_rows: list[list[Any]] = []
        for question in llm_questions:
            llm_rows.append(
                [
                    _build_label_paragraph(question, label_style),
                    _format_answer_paragraph(question, body_style),
                ]
            )
        llm_table = Table(llm_rows, colWidths=[60 * mm, None])
        llm_table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#8a8a8a")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#b0b0b0")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        elements.append(llm_table)

    elements.append(Paragraph("自動生成サマリー", section_style))
    summary_text = session.get("summary")
    if summary_text:
        summary_para = Paragraph(escape(str(summary_text)).replace("\n", "<br/>"), body_style)
    else:
        summary_para = Paragraph("サマリーは生成されていません。", body_style)
    summary_table = Table([[summary_para]])
    summary_table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#8a8a8a")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    elements.append(summary_table)

    def _add_footer(canvas, doc) -> None:
        canvas.saveState()
        canvas.setFont(MINCHO_FONT, 9)
        canvas.setFillColor(colors.HexColor("#777777"))
        canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"{doc.page}")
        canvas.restoreState()

    doc.build(elements, onFirstPage=_add_footer, onLaterPages=_add_footer)
    buf.seek(0)
    return buf.getvalue()

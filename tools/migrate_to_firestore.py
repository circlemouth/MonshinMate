#!/usr/bin/env python3
"""SQLite から Firestore へ既存データを移行する PoC スクリプト。

requirements:
    - google-cloud-firestore (backend/pyproject.toml で管理)
    - Firestore プロジェクト / エミュレータ接続情報

使い方:
    $ export PERSISTENCE_BACKEND=firestore
    $ export FIRESTORE_PROJECT_ID=your-project-id
    # エミュレータ利用時:
    # gcloud beta emulators firestore start --host-port=localhost:8081
    # export FIRESTORE_EMULATOR_HOST=localhost:8081
    $ python tools/migrate_to_firestore.py --sqlite-db backend/app/app.sqlite3

注意:
    - セッションログや添付ファイル、監査ログの詳細などは今後対応予定。
    - `--dry-run` を指定すると書き込みを行わず件数のみ出力する。
"""

from __future__ import annotations

import argparse
import logging
import os
from types import SimpleNamespace
from typing import Any

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.config import get_settings
from app.db.sqlite_adapter import SQLiteAdapter
from app.db.firestore_adapter import FirestoreAdapter


logger = logging.getLogger("migrate")


def _build_session_namespace(data: dict[str, Any]) -> SimpleNamespace:
    defaults = {
        "template_items": [],
        "pending_llm_questions": data.get("pending_llm_questions", []),
        "followup_prompt": data.get("followup_prompt", ""),
    }
    merged = {**defaults, **data}
    return SimpleNamespace(**merged)


def migrate(sqlite_db: str, dry_run: bool = False, limit: int | None = None) -> None:
    source = SQLiteAdapter(sqlite_db)
    source.init(sqlite_db)

    settings = get_settings()
    target = FirestoreAdapter(settings.firestore)
    target.init()

    logger.info("Starting migration from %s", sqlite_db)

    templates = source.list_templates(db_path=sqlite_db)
    logger.info("Found %d templates", len(templates))
    migrated_templates = 0
    for tpl in templates:
        template_id = tpl["id"]
        visit_type = tpl["visit_type"]
        template_data = source.get_template(template_id, visit_type, db_path=sqlite_db)
        if not template_data:
            continue
        if dry_run:
            migrated_templates += 1
            continue
        target.upsert_template(
            template_id,
            visit_type,
            template_data.get("items", []),
            template_data.get("llm_followup_enabled", True),
            template_data.get("llm_followup_max_questions", 5),
        )
        summary_cfg = source.get_summary_config(template_id, visit_type, db_path=sqlite_db)
        if summary_cfg:
            target.upsert_summary_prompt(
                template_id,
                visit_type,
                summary_cfg.get("prompt", ""),
                enabled=summary_cfg.get("enabled", False),
            )
        followup_cfg = source.get_followup_config(template_id, visit_type, db_path=sqlite_db)
        if followup_cfg:
            target.upsert_followup_prompt(
                template_id,
                visit_type,
                followup_cfg.get("prompt", ""),
                enabled=followup_cfg.get("enabled", False),
            )
        migrated_templates += 1

    logger.info("Migrated templates: %d", migrated_templates)

    # デフォルトテンプレート設定
    if not dry_run:
        app_settings = source.load_app_settings(db_path=sqlite_db) or {}
        if app_settings:
            target.save_app_settings(app_settings)

    sessions = source.list_sessions(db_path=sqlite_db)
    if limit is not None:
        sessions = sessions[:limit]
    logger.info("Found %d sessions", len(sessions))
    migrated_sessions = 0
    for summary in sessions:
        session_id = summary.get("id")
        if not session_id:
            continue
        detail = source.get_session(session_id, db_path=sqlite_db)
        if not detail:
            continue
        if dry_run:
            migrated_sessions += 1
            continue
        namespace = _build_session_namespace(detail)
        target.save_session(namespace)
        migrated_sessions += 1

    logger.info("Migrated sessions: %d", migrated_sessions)

    logger.info("Migration completed%s", " (dry-run)" if dry_run else "")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate data from SQLite to Firestore")
    parser.add_argument(
        "--sqlite-db",
        default=os.environ.get("MONSHINMATE_DB", "backend/app/app.sqlite3"),
        help="SQLite ファイルへのパス (default: backend/app/app.sqlite3)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="移行するセッション数の上限 (デフォルト: 全件)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="書き込みを行わず件数のみ確認する",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="ログレベル (default: INFO)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    migrate(args.sqlite_db, dry_run=args.dry_run, limit=args.limit)


if __name__ == "__main__":
    main()

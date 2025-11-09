from __future__ import annotations

"""LLM プロバイダのメタデータとプラグインローダー。"""

from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, TYPE_CHECKING
import logging
import os
import sys

from pydantic import BaseModel, Field

from .llm_providers.gcp_vertex import (
    GCP_VERTEX_PROVIDER_META,
    GcpVertexProvider,
)


class ProviderFieldSchema(BaseModel):
    """LLM プロバイダの追加設定項目を表すスキーマ。"""

    key: str
    label: str
    type: str = "text"
    required: bool = False
    helper: str | None = None
    placeholder: str | None = None
    options: list[dict[str, Any]] | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    accept: str | None = None


class ProviderMetaSchema(BaseModel):
    """LLM プロバイダの表示・デフォルト設定に関するメタ情報。"""

    key: str
    label: str
    description: str
    helper: str | None = None
    use_base_url: bool = True
    use_api_key: bool = True
    default_profile: dict[str, Any] = Field(default_factory=dict)
    extra_fields: list[ProviderFieldSchema] = Field(default_factory=list)


class LLMProviderAdapter(Protocol):
    """外部プロバイダ実装が満たすべきインターフェース。"""

    meta: ProviderMetaSchema

    def normalize_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        """プロファイルの正規化・既定値補完を行う。"""

    def list_models(
        self, settings: "LLMSettings", profile: dict[str, Any], *, source: str | None = None
    ) -> list[str]:
        """利用可能なモデル一覧を返す。"""

    def test_connection(
        self, settings: "LLMSettings", profile: dict[str, Any], *, source: str | None = None
    ) -> dict[str, str]:
        """疎通テストの結果を返す。"""

    def generate_question(
        self,
        settings: "LLMSettings",
        profile: dict[str, Any],
        missing_item_id: str,
        missing_item_label: str,
        context: dict[str, Any] | None,
    ) -> str:
        """単一項目に対する追質問を生成する。"""

    def generate_followups(
        self,
        settings: "LLMSettings",
        profile: dict[str, Any],
        context: dict[str, Any],
        max_questions: int,
        prompt: str | None = None,
    ) -> list[str]:
        """複数の追質問をまとめて生成する。"""

    def chat(
        self, settings: "LLMSettings", profile: dict[str, Any], message: str
    ) -> str:
        """チャット形式の応答を生成する。"""

    def summarize_with_prompt(
        self,
        settings: "LLMSettings",
        profile: dict[str, Any],
        system_prompt: str,
        answers: dict[str, Any],
        labels: dict[str, str] | None = None,
    ) -> str:
        """サマリーを生成する。"""


@dataclass
class ProviderRegistration:
    """プロバイダと実装の対応関係。"""

    meta: ProviderMetaSchema
    adapter: LLMProviderAdapter | None = None


_DEFAULT_PROVIDER_ORDER: list[str] = ["ollama", "lm_studio", "openai", "gcp_vertex"]

_DEFAULT_PROVIDER_META: dict[str, ProviderMetaSchema] = {
    "ollama": ProviderMetaSchema(
        key="ollama",
        label="Ollama",
        description="ローカルで稼働する Ollama サーバー向けの設定です。",
        helper="ベースURLが空の場合は http://localhost:11434 を使用します。",
        default_profile={
            "base_url": "http://localhost:11434",
            "api_key": "",
            "model": "",
            "temperature": 0.2,
            "system_prompt": "",
            "followup_timeout_seconds": 30,
        },
    ),
    "lm_studio": ProviderMetaSchema(
        key="lm_studio",
        label="LM Studio",
        description="LM Studio のWebサーバーへ接続してモデルを利用します。",
        helper="LM Studio の Web UI に表示されるエンドポイントURLを入力してください。",
        default_profile={
            "base_url": "http://localhost:1234",
            "api_key": "",
            "model": "",
            "temperature": 0.2,
            "system_prompt": "",
            "followup_timeout_seconds": 30,
        },
    ),
    "openai": ProviderMetaSchema(
        key="openai",
        label="OpenAI (互換API含む)",
        description="OpenAI / Azure OpenAI / 互換API サービスを利用します。",
        helper="ベースURLに https://api.openai.com 等を設定し、APIキーを入力してください。",
        default_profile={
            "base_url": "https://api.openai.com",
            "api_key": "",
            "model": "",
            "temperature": 0.2,
            "system_prompt": "",
            "followup_timeout_seconds": 30,
        },
    ),
    "gcp_vertex": ProviderMetaSchema(
        key=GCP_VERTEX_PROVIDER_META["key"],
        label=GCP_VERTEX_PROVIDER_META["label"],
        description=GCP_VERTEX_PROVIDER_META["description"],
        helper=GCP_VERTEX_PROVIDER_META.get("helper"),
        use_base_url=GCP_VERTEX_PROVIDER_META.get("use_base_url", False),
        use_api_key=GCP_VERTEX_PROVIDER_META.get("use_api_key", False),
        default_profile=dict(GCP_VERTEX_PROVIDER_META.get("default_profile", {})),
        extra_fields=[
            ProviderFieldSchema(**field)
            for field in GCP_VERTEX_PROVIDER_META.get("extra_fields", [])
        ],
    ),
}


_BUILTIN_ADAPTERS: dict[str, LLMProviderAdapter] = {}
try:
    _gcp_adapter = GcpVertexProvider()
except Exception as exc:  # noqa: BLE001 - 初期化失敗時はロギングのみ
    logging.getLogger("llm.registry").warning("gcp_vertex_adapter_init_failed: %s", exc)
else:
    _BUILTIN_ADAPTERS[GCP_VERTEX_PROVIDER_META["key"]] = _gcp_adapter


def _resolve_project_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "private" / "cloud-run-adapter"
        if candidate.exists():
            return parent
    return Path(__file__).resolve().parents[2]


_PROJECT_ROOT = _resolve_project_root()
_PRIVATE_DIR = _PROJECT_ROOT / "private"
_ADAPTER_DIR = _PRIVATE_DIR / "cloud-run-adapter"
for candidate in (_ADAPTER_DIR, _PRIVATE_DIR):
    if candidate.exists():
        path_str = str(candidate)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)


def _parse_adapter_spec(spec: str) -> tuple[str, str]:
    stripped = spec.strip()
    if not stripped:
        return ("", "get_provider")
    if ":" in stripped:
        module_name, attr = stripped.split(":", 1)
        return (module_name.strip(), (attr or "get_provider").strip() or "get_provider")
    if "." in stripped:
        module_name, attr = stripped.rsplit(".", 1)
        return (module_name.strip(), (attr or "get_provider").strip() or "get_provider")
    return (stripped, "get_provider")


def _load_external_adapter() -> LLMProviderAdapter | None:
    env_spec = os.getenv("MONSHINMATE_LLM_PROVIDER_ADAPTER", "")
    candidates: list[str] = []
    if env_spec:
        candidates.extend(part for part in env_spec.split(",") if part.strip())
    candidates.extend(
        [
            "monshinmate_cloud.llm_provider:get_provider",
            "monshinmate_cloud_run.llm_provider:get_provider",
            "app.llm.llm_provider:get_provider",
        ]
    )
    seen: set[tuple[str, str]] = set()
    for spec in candidates:
        module_name, attr_name = _parse_adapter_spec(spec)
        if not module_name:
            continue
        key = (module_name, attr_name)
        if key in seen:
            continue
        seen.add(key)
        try:
            module = import_module(module_name)
        except ModuleNotFoundError:
            continue
        adapter_obj = getattr(module, attr_name, None)
        if adapter_obj is None:
            continue
        if callable(adapter_obj):
            try:
                adapter = adapter_obj()
            except TypeError:
                adapter = adapter_obj  # call 失敗時はそのまま扱う
        else:
            adapter = adapter_obj
        meta = getattr(adapter, "meta", None)
        if meta is None:
            continue
        # Duck typing: meta に必要属性が揃っているかを確認
        try:
            ProviderMetaSchema(**meta if isinstance(meta, dict) else meta.model_dump())
        except Exception:
            try:
                meta_model = meta
                if isinstance(meta_model, ProviderMetaSchema):
                    return adapter  # type: ignore[return-value]
                candidate_meta = ProviderMetaSchema(
                    key=meta_model.key,
                    label=meta_model.label,
                    description=meta_model.description,
                    helper=getattr(meta_model, "helper", None),
                    use_base_url=getattr(meta_model, "use_base_url", True),
                    use_api_key=getattr(meta_model, "use_api_key", True),
                    default_profile=dict(getattr(meta_model, "default_profile", {}) or {}),
                    extra_fields=[
                        ProviderFieldSchema(**field)
                        if isinstance(field, dict)
                        else ProviderFieldSchema(**field.model_dump())
                        for field in getattr(meta_model, "extra_fields", []) or []
                    ],
                )
                setattr(adapter, "meta", candidate_meta)
                return adapter  # type: ignore[return-value]
            except Exception:
                continue
        else:
            if isinstance(meta, dict):
                setattr(adapter, "meta", ProviderMetaSchema(**meta))
            return adapter  # type: ignore[return-value]
    return None


def _build_registry() -> dict[str, ProviderRegistration]:
    registry: dict[str, ProviderRegistration] = {
        key: ProviderRegistration(meta=meta)
        for key, meta in _DEFAULT_PROVIDER_META.items()
    }
    for key, adapter in _BUILTIN_ADAPTERS.items():
        meta = adapter.meta
        if isinstance(meta, ProviderMetaSchema):
            meta_schema = meta
        elif isinstance(meta, dict):
            meta_schema = ProviderMetaSchema(**meta)
            adapter.meta = meta_schema  # type: ignore[assignment]
        else:
            meta_schema = ProviderMetaSchema(
                key=getattr(meta, "key"),
                label=getattr(meta, "label"),
                description=getattr(meta, "description"),
                helper=getattr(meta, "helper", None),
                use_base_url=getattr(meta, "use_base_url", True),
                use_api_key=getattr(meta, "use_api_key", True),
                default_profile=dict(getattr(meta, "default_profile", {}) or {}),
                extra_fields=[
                    ProviderFieldSchema(**field)
                    if isinstance(field, dict)
                    else ProviderFieldSchema(**field.model_dump())
                    for field in getattr(meta, "extra_fields", []) or []
                ],
            )
            adapter.meta = meta_schema  # type: ignore[assignment]
        registry[key] = ProviderRegistration(meta=meta_schema, adapter=adapter)
    adapter = _load_external_adapter()
    if adapter is None:
        return registry
    meta = adapter.meta
    if isinstance(meta, dict):
        meta_schema = ProviderMetaSchema(**meta)
        adapter.meta = meta_schema  # type: ignore[assignment]
    elif isinstance(meta, ProviderMetaSchema):
        meta_schema = meta
    else:
        # Fallback: try to coerce attributes
        meta_schema = ProviderMetaSchema(
            key=getattr(meta, "key"),
            label=getattr(meta, "label"),
            description=getattr(meta, "description"),
            helper=getattr(meta, "helper", None),
            use_base_url=getattr(meta, "use_base_url", True),
            use_api_key=getattr(meta, "use_api_key", True),
            default_profile=dict(getattr(meta, "default_profile", {}) or {}),
            extra_fields=[
                ProviderFieldSchema(**field)
                if isinstance(field, dict)
                else ProviderFieldSchema(**field.model_dump())
                for field in getattr(meta, "extra_fields", []) or []
            ],
        )
        adapter.meta = meta_schema  # type: ignore[assignment]
    registry[meta_schema.key] = ProviderRegistration(meta=meta_schema, adapter=adapter)
    return registry


_REGISTRY = _build_registry()
_ORDERED_KEYS: list[str] = []
for key in _DEFAULT_PROVIDER_ORDER:
    if key in _REGISTRY:
        _ORDERED_KEYS.append(key)
for key in _REGISTRY.keys():
    if key not in _ORDERED_KEYS:
        _ORDERED_KEYS.append(key)


def get_provider_registry() -> dict[str, ProviderRegistration]:
    """利用可能な LLM プロバイダ登録情報を返す。"""

    return dict(_REGISTRY)


def get_ordered_provider_keys() -> list[str]:
    """UI 表示順に並んだプロバイダキー一覧を返す。"""

    return list(_ORDERED_KEYS)


def get_provider_meta_list() -> list[ProviderMetaSchema]:
    """プロバイダのメタ情報一覧（表示順）。"""

    registry = get_provider_registry()
    return [registry[key].meta for key in get_ordered_provider_keys() if key in registry]


if TYPE_CHECKING:  # pragma: no cover
    from .llm_gateway import LLMSettings  # noqa: F401


__all__ = [
    "ProviderFieldSchema",
    "ProviderMetaSchema",
    "LLMProviderAdapter",
    "ProviderRegistration",
    "get_provider_registry",
    "get_ordered_provider_keys",
    "get_provider_meta_list",
]

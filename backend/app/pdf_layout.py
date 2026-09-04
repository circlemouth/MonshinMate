"""PDF レイアウト種別の軽量な共有定義。"""

from enum import Enum


class PDFLayoutMode(str, Enum):
    """PDFレイアウトの切り替えモード。"""

    STRUCTURED = "structured"
    LEGACY = "legacy"


__all__ = ["PDFLayoutMode"]

import tkinter as tk


class WrapperGUI:
    """録音ラッパーGUI。"""

    def __init__(self, master: tk.Misc) -> None:
        """初期化。"""
        self.master = master
        self.status_var = tk.StringVar()

    def start_recording(self) -> None:
        """録音を開始する。内部エラー発生時はステータスに表示する。"""
        try:
            # 実際の録音処理はここに実装される想定
            pass
        except Exception as e:  # noqa: BLE001 - GUI表示用に全て捕捉
            # Python 3.11以降では except 節を抜けると例外変数が解放されるため、
            # コールバック内で参照できなくなる。既定値として渡し、名前解決エラーを防ぐ。
            self.master.after(0, lambda err=e: self.status_var.set(f"error: {err}"))

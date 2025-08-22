@echo off
setlocal

:: システム全体を一括起動するスクリプト (Windows版)
:: - バックエンド: FastAPI(Uvicorn)
:: - フロントエンド: Vite(React)

:: ルートディレクトリと venv ディレクトリを設定
set "ROOT_DIR=%~dp0"
:: 末尾のバックスラッシュを削除
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "VENV_DIR=%ROOT_DIR%\venv"

:: venv と最小依存確認（存在しなければ作成）
if not exist "%VENV_DIR%\Scripts\uvicorn.exe" (
  echo [setup] venv が未作成のため作成します
  python -m venv "%VENV_DIR%"
  call "%VENV_DIR%\Scripts\activate.bat"
  python -m pip install --upgrade pip
  :: 最小限の依存をインストール（必要に応じて拡張）
  pip install fastapi uvicorn httpx
) else (
  call "%VENV_DIR%\Scripts\activate.bat"
)

echo [start] backend: http://localhost:8000
:: 新しいウィンドウでバックエンドを起動
:: /k オプションでコマンド実行後もウィンドウを開いたままにし、ログを確認できるようにします
start "Backend Server" cmd /k "call ""%VENV_DIR%\Scripts\activate.bat"" && cd /d ""%ROOT_DIR%\backend"" && uvicorn app.main:app --reload --port 8000"

echo [start] frontend: http://localhost:5173

:: pnpm, yarn, npm の順に利用可能なパッケージマネージャを確認
set "FRONTEND_CMD="
where pnpm >nul 2>nul
if %errorlevel% equ 0 (
    echo [setup] frontend の依存関係をインストールします (pnpm)
    set "FRONTEND_CMD=pnpm install && pnpm run dev"
) else (
    where yarn >nul 2>nul
    if %errorlevel% equ 0 (
        echo [setup] frontend の依存関係をインストールします (yarn)
        set "FRONTEND_CMD=yarn install && yarn dev"
    ) else (
        echo [setup] frontend の依存関係をインストールします (npm)
        set "FRONTEND_CMD=npm install && npm run dev"
    )
)

:: 新しいウィンドウでフロントエンドを起動
start "Frontend Server" cmd /k "cd /d ""%ROOT_DIR%\frontend"" && %FRONTEND_CMD%"


echo.
echo [ready] バックエンドとフロントエンドをそれぞれ別のウィンドウで起動しました。
echo [ready] サーバーを停止するには、各ウィンドウで Ctrl-C を押すか、ウィンドウを閉じてください。
echo.

endlocal
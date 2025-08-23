# PowerShell 用の開発サーバー一括起動スクリプト
# - バックエンド: FastAPI(Uvicorn)
# - フロントエンド: Vite(React)

Set-StrictMode -Version Latest

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $RootDir 'venv'

$backend = $null
$frontend = $null

try {
    if (-not (Test-Path $VenvDir)) {
        Write-Host "[setup] venv が未作成のため作成します"
        python -m venv $VenvDir
    }
    . (Join-Path $VenvDir 'Scripts' 'Activate.ps1')

    Write-Host "[setup] backend の依存関係をインストールします"
    & "$VenvDir/Scripts/python.exe" -m pip install --upgrade pip
    Push-Location (Join-Path $RootDir 'backend')
    & "$VenvDir/Scripts/python.exe" -m pip install -e .
    Pop-Location

    Write-Host "[start] backend: http://localhost:8001"
    $backend = Start-Process -FilePath (Join-Path $VenvDir 'Scripts' 'uvicorn.exe') `
        -ArgumentList 'app.main:app','--reload','--port','8001' `
        -WorkingDirectory (Join-Path $RootDir 'backend') -PassThru -NoNewWindow

    Write-Host "[start] frontend: http://localhost:5173"
    Push-Location (Join-Path $RootDir 'frontend')
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Host "[setup] frontend の依存関係をインストールします (pnpm)"
        pnpm install
        $frontend = Start-Process -FilePath pnpm -ArgumentList 'run','dev' -PassThru -NoNewWindow
    } elseif (Get-Command yarn -ErrorAction SilentlyContinue) {
        Write-Host "[setup] frontend の依存関係をインストールします (yarn)"
        yarn install
        $frontend = Start-Process -FilePath yarn -ArgumentList 'dev' -PassThru -NoNewWindow
    } else {
        Write-Host "[setup] frontend の依存関係をインストールします (npm)"
        npm install
        $frontend = Start-Process -FilePath npm -ArgumentList 'run','dev' -PassThru -NoNewWindow
    }
    Pop-Location

    Write-Host "[ready] Ctrl-C で両方のプロセスを終了します"

    while ($backend.HasExited -eq $false -and $frontend.HasExited -eq $false) {
        Start-Sleep -Seconds 1
    }
}
finally {
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id }
    if ($frontend -and -not $frontend.HasExited) { Stop-Process -Id $frontend.Id }
}

# Batch startup script for development server using PowerShell
# - Backend: FastAPI(Uvicorn)
# - Frontend: Vite(React)

Set-StrictMode -Version Latest

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $RootDir 'venv'

$backend = $null
$frontend = $null

try {
    if (-not (Test-Path $VenvDir)) {
        Write-Host "[setup] Creating venv because it does not exist."
        python -m venv $VenvDir
    }
    . (Join-Path $VenvDir 'Scripts\Activate.ps1')

    Write-Host "[setup] Installing backend dependencies."
    & "$VenvDir/Scripts/python.exe" -m pip install --upgrade pip
    Push-Location (Join-Path $RootDir 'backend')
    & "$VenvDir/Scripts/python.exe" -m pip install -e .
    Pop-Location

    Write-Host "[start] backend: http://localhost:8001"
    $backend = Start-Process -FilePath (Join-Path $VenvDir 'Scripts\uvicorn.exe') `
        -ArgumentList 'app.main:app','--reload','--port','8001' `
        -WorkingDirectory (Join-Path $RootDir 'backend') -PassThru -NoNewWindow

    Write-Host "[start] frontend: http://localhost:5173"
    Push-Location (Join-Path $RootDir 'frontend')
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Host "[setup] Installing frontend dependencies (pnpm)."
        pnpm install
        $frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm", "run", "dev" -PassThru -NoNewWindow
    } elseif (Get-Command yarn -ErrorAction SilentlyContinue) {
        Write-Host "[setup] Installing frontend dependencies (yarn)."
        yarn install
        $frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "yarn", "dev" -PassThru -NoNewWindow
    } else {
        Write-Host "[setup] Installing frontend dependencies (npm)."
        npm install
        $frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm", "run", "dev" -PassThru -NoNewWindow
    }
    Pop-Location

    Write-Host "[ready] Press Ctrl-C to terminate both processes."

    while ($backend.HasExited -eq $false -and $frontend.HasExited -eq $false) {
        Start-Sleep -Seconds 1
    }
}
finally {
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id }
    if ($frontend -and -not $frontend.HasExited) { Stop-Process -Id $frontend.Id }
}
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

    # Load backend/.env to export environment variables (for emergency reset, CouchDB, etc.)
    $BackendDir = Join-Path $RootDir 'backend'
    $DotenvPath = Join-Path $BackendDir '.env'
    if (Test-Path $DotenvPath) {
        Write-Host "[setup] Loading backend/.env"
        Get-Content $DotenvPath | ForEach-Object {
            $line = $_.Trim()
            if (-not $line -or $line.StartsWith('#')) { return }
            # Basic KEY=VALUE parsing
            $eq = $line.IndexOf('=')
            if ($eq -gt 0) {
                $k = $line.Substring(0, $eq).Trim()
                $v = $line.Substring($eq + 1).Trim()
                if ((($v.StartsWith('"')) -and ($v.EndsWith('"'))) -or (($v.StartsWith("'")) -and ($v.EndsWith("'")))) {
                    $v = $v.Substring(1, $v.Length - 2)
                }
                Set-Item -Path Env:$k -Value $v -ErrorAction SilentlyContinue
            }
        }
    }

    # If CouchDB is configured but unreachable, fall back to SQLite for local development
    if ($env:COUCHDB_URL) {
        $reachable = $false
        try {
            $uri = [Uri]$env:COUCHDB_URL
            $host = $uri.Host
            $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq 'https') { 443 } else { 80 }
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect($host, $port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(1000, $false)) {
                $client.EndConnect($iar)
                $reachable = $true
            }
            $client.Close()
        } catch { $reachable = $false }
        if (-not $reachable) {
            Write-Host "[warn] COUCHDB_URL=$($env:COUCHDB_URL) に接続できません。SQLite にフォールバックします"
            $env:COUCHDB_URL = ''
            $env:COUCHDB_DB = ''
            $env:COUCHDB_USER = ''
            $env:COUCHDB_PASSWORD = ''
        } else {
            Write-Host "[info] CouchDB に接続可能: $($env:COUCHDB_URL)"
        }
    }

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

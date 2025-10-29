# Batch startup script for development server using PowerShell
# - Backend: FastAPI(Uvicorn)
# - Frontend: Vite(React)

Set-StrictMode -Version Latest

# Clear read-only attributes under frontend/node_modules when OneDrive locks files
function Clear-ReadOnlyAttributes {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $readOnlyFlag = [System.IO.FileAttributes]::ReadOnly

    try {
        $rootItem = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($rootItem.Attributes -band $readOnlyFlag) {
            $rootItem.Attributes = $rootItem.Attributes -band (-bnot $readOnlyFlag)
        }
    } catch {
        Write-Verbose "clear-readonly(root): $_"
    }

    Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Attributes -band $readOnlyFlag) {
                $_.Attributes = $_.Attributes -band (-bnot $readOnlyFlag)
            }
        } catch {
            Write-Verbose "clear-readonly(child): $_"
        }
    }
}


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

    # Load repository root .env to export environment variables for backend/frontend
    $DotenvPath = Join-Path $RootDir '.env'
    if (Test-Path $DotenvPath) {
        Write-Host "[setup] Loading .env"
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

    $requiresFirestore = $false
    if ($env:PERSISTENCE_BACKEND) {
        $requiresFirestore = $env:PERSISTENCE_BACKEND.ToLowerInvariant() -eq 'firestore'
    }
    if (-not $requiresFirestore -and $env:MONSHINMATE_FIRESTORE_ADAPTER) {
        $requiresFirestore = $true
    }

    if ($requiresFirestore) {
        $pipExe = Join-Path $VenvDir 'Scripts\pip.exe'
        if (-not (Test-Path -LiteralPath $pipExe)) {
            $pipExe = Join-Path $VenvDir 'Scripts\pip'
        }
        $firestorePackages = @(
            "google-cloud-firestore",
            "google-cloud-secret-manager",
            "google-cloud-storage",
            "firebase-admin"
        )
        $missingPackages = @()
        foreach ($pkg in $firestorePackages) {
            & $pipExe 'show' $pkg *> $null
            if ($LASTEXITCODE -ne 0) {
                $missingPackages += $pkg
            }
        }
        if ($missingPackages.Count -gt 0) {
            Write-Host "[setup] Installing Firestore dependencies: $($missingPackages -join ', ')"
            $pipArgs = @('install') + $missingPackages
            & $pipExe @pipArgs
        } else {
            Write-Host "[setup] Firestore dependencies already installed."
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
            Write-Host "[warn] Unable to reach COUCHDB_URL=$($env:COUCHDB_URL); falling back to SQLite."
            $env:COUCHDB_URL = ''
            $env:COUCHDB_DB = ''
            $env:COUCHDB_USER = ''
            $env:COUCHDB_PASSWORD = ''
        } else {
            Write-Host "[info] CouchDB reachable: $($env:COUCHDB_URL)"
        }
    }

    Write-Host "[start] backend: http://localhost:8001"
    $backend = Start-Process -FilePath (Join-Path $VenvDir 'Scripts\uvicorn.exe') `
        -ArgumentList 'app.main:app','--reload','--port','8001' `
        -WorkingDirectory (Join-Path $RootDir 'backend') -PassThru -NoNewWindow

    Write-Host "[start] frontend: http://localhost:5173"
    Push-Location (Join-Path $RootDir 'frontend')
    $nodeModulesPath = 'node_modules'
    if (Test-Path -LiteralPath $nodeModulesPath) {
        Write-Host "[setup] Clearing read-only flags in frontend/node_modules."
        Clear-ReadOnlyAttributes -Path $nodeModulesPath
    }

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

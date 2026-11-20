[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Create', 'Start', 'Status', 'Stop')]
    [string]$Action = 'Plan',
    [string]$PgBin = ''
)

$ErrorActionPreference = 'Stop'
$backRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = [IO.Path]::GetFullPath((Join-Path $backRoot '.local'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $localRoot 'postgres'))
$dataPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data'))
$logPath = Join-Path $runtimeRoot 'postgres.log'
$pgBinPath = Join-Path $runtimeRoot 'pg-bin.txt'
$backendEnvPath = Join-Path $localRoot 'backend.env'
$ownerEnvPath = Join-Path $localRoot 'database-owner.env'
$port = 54329

if (-not $runtimeRoot.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe local database path.'
}
if ([IO.Path]::GetFileName($runtimeRoot) -ne 'postgres' -or [IO.Path]::GetFileName($dataPath) -ne 'data') {
    throw 'Unexpected local database path.'
}

function Protect-Directory {
    param([string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $Path '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)F" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not protect local secrets.' }
    }
}

function New-HexSecret {
    $bytes = [byte[]]::new(32)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function New-Base64Secret {
    $bytes = [byte[]]::new(32)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes)
}

function Resolve-PgBin {
    param([bool]$Required)
    $candidate = $PgBin
    if (-not $candidate -and (Test-Path -LiteralPath $pgBinPath)) {
        $candidate = (Get-Content -LiteralPath $pgBinPath -Raw).Trim()
    }
    if (-not $candidate) {
        if ($Required) { throw 'Pass -PgBin with the PostgreSQL 18 bin directory.' }
        return $null
    }
    $resolved = [IO.Path]::GetFullPath($candidate)
    foreach ($executable in @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'psql.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolved $executable))) {
            throw "PostgreSQL executable not found: $executable"
        }
    }
    if ((& (Join-Path $resolved 'psql.exe') --version) -notmatch 'PostgreSQL\) 18\.') {
        throw 'PostgreSQL 18 is required.'
    }
    return $resolved
}

function Test-PortBusy {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Test-DatabaseRunning {
    param([string]$ResolvedPgBin)
    if (-not (Test-Path -LiteralPath $dataPath)) { return $false }
    & (Join-Path $ResolvedPgBin 'pg_ctl.exe') status '-D' $dataPath *> $null
    return $LASTEXITCODE -eq 0
}

function Start-LocalDatabase {
    param([string]$ResolvedPgBin)
    if (Test-DatabaseRunning -ResolvedPgBin $ResolvedPgBin) {
        Write-Output 'The local database is already running.'
        return
    }
    if (Test-PortBusy) { throw "Port $port is already used by another process." }
    $arguments = @(
        'start', '-D', $dataPath, '-l', $logPath,
        '-o', "-h 127.0.0.1 -p $port -c timezone=UTC -c log_timezone=UTC", '-w'
    )
    & (Join-Path $ResolvedPgBin 'pg_ctl.exe') @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not start. Inspect .local/postgres/postgres.log.' }
    Write-Output "The local database is running at 127.0.0.1:$port."
}

function Read-EnvironmentFile {
    param([string]$Path)
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
        $parts = $line.Split('=', 2)
        $values[$parts[0]] = $parts[1]
    }
    return $values
}

if ($Action -eq 'Plan') {
    [ordered]@{
        changesData = $false
        database = 'meal_planner_postgres'
        address = "127.0.0.1:$port"
        storage = $dataPath
        steps = @(
            'Create an isolated development-only PostgreSQL 18 cluster',
            'Apply every migration from the current manifest',
            'Insert system reference data only',
            'Create a least-privilege application role',
            'Store random local keys in the protected .local directory'
        )
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Action -eq 'Create') {
    $resolvedPgBin = Resolve-PgBin -Required $true
    if ((Test-Path -LiteralPath $dataPath) -or (Test-Path -LiteralPath $backendEnvPath) -or (Test-Path -LiteralPath $ownerEnvPath)) {
        throw 'The local database or its settings already exist. Nothing will be overwritten.'
    }
    if (Test-PortBusy) { throw "Port $port is already in use. That process will not be used or stopped." }

    $ownerPassword = New-HexSecret
    $appPassword = New-HexSecret
    $securityKey = New-Base64Secret
    $mfaKey = New-Base64Secret
    $passwordPath = Join-Path $runtimeRoot 'owner-password.pending'
    $ownerEnv = @(
        'PGHOST=127.0.0.1', 'PGHOSTADDR=127.0.0.1', "PGPORT=$port",
        'PGUSER=meal_owner', 'PGDATABASE=meal_planner_postgres', "PGPASSWORD=$ownerPassword", ''
    ) -join [Environment]::NewLine
    try {
        Protect-Directory -Path $localRoot
        Protect-Directory -Path $runtimeRoot
        [IO.File]::WriteAllText($passwordPath, $ownerPassword, [Text.UTF8Encoding]::new($false))
        & (Join-Path $resolvedPgBin 'initdb.exe') '-D' $dataPath '-U' 'meal_owner' '--encoding=UTF8' '--locale=C' '--auth=scram-sha-256' "--pwfile=$passwordPath" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the local PostgreSQL cluster.' }
        Remove-Item -LiteralPath $passwordPath -Force

        [IO.File]::WriteAllText($pgBinPath, $resolvedPgBin + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($ownerEnvPath, $ownerEnv, [Text.UTF8Encoding]::new($false))
        Start-LocalDatabase -ResolvedPgBin $resolvedPgBin

        $databaseEnvironment = @{
            PGHOST = '127.0.0.1'
            PGHOSTADDR = '127.0.0.1'
            PGPORT = [string]$port
            PGUSER = 'meal_owner'
            PGDATABASE = 'meal_planner_postgres'
            PGPASSWORD = $ownerPassword
        }
        foreach ($entry in $databaseEnvironment.GetEnumerator()) { Set-Item -LiteralPath "Env:$($entry.Key)" -Value $entry.Value }

        & (Join-Path $resolvedPgBin 'createdb.exe') '-w' '--maintenance-db=postgres' '--template=template0' '--encoding=UTF8' '--locale=C' 'meal_planner_postgres'
        if ($LASTEXITCODE -ne 0) { throw 'Could not create meal_planner_postgres.' }

        Push-Location $backRoot
        try {
            & node scripts/migrate.mjs --apply --environment=development
            if ($LASTEXITCODE -ne 0) { throw 'Could not apply database migrations.' }
            & (Join-Path $resolvedPgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-f' (Join-Path $backRoot 'database\reference-data.sql') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not insert reference data.' }

            $roleSql = "CREATE ROLE meal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS PASSWORD '$appPassword'; CREATE ROLE meal_mail_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS; CREATE ROLE meal_media_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS; GRANT CONNECT ON DATABASE meal_planner_postgres TO meal_app; GRANT USAGE ON SCHEMA meal TO meal_app;"
            & (Join-Path $resolvedPgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-c' $roleSql | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not create least-privilege application roles.' }
            & (Join-Path $resolvedPgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-f' (Join-Path $backRoot 'database\application-grants.sql') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not apply least-privilege grants.' }
        }
        finally { Pop-Location }

        $backendEnv = @(
            'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=3001',
            'FRONTEND_ORIGIN=http://localhost:3000', 'ADMIN_FRONTEND_ORIGIN=http://localhost:3002',
            'LEGAL_EVIDENCE_MODE=demonstration',
            "DATABASE_URL=postgresql://meal_app:$appPassword@127.0.0.1:$port/meal_planner_postgres",
            "SECURITY_KEY=$securityKey", "MFA_ENCRYPTION_KEY=$mfaKey",
            'LOG_LEVEL=info', 'AUTH_RATE_LIMIT=10', 'TRUSTED_PROXY_CIDRS=',
            'ADMIN_ALLOWED_IPS=', 'ADMIN_RECOVERY_ENABLED=false', 'ADMIN_BOOTSTRAP_ENABLED=false', ''
        ) -join [Environment]::NewLine
        [IO.File]::WriteAllText($backendEnvPath, $backendEnv, [Text.UTF8Encoding]::new($false))

        $env:PGUSER = 'meal_app'
        $env:PGPASSWORD = $appPassword
        $facts = & (Join-Path $resolvedPgBin 'psql.exe') '-w' '-tA' '-c' "select current_user,(select count(*) from meal.schema_migrations),(select count(*) from meal.units),(select count(*) from meal.billing_products);"
        if ($LASTEXITCODE -ne 0 -or $facts.Trim() -ne 'meal_app|42|7|3') { throw 'Final database verification failed.' }
        Write-Output 'The local development database is ready. Its data persists between runs.'
    }
    catch {
        Write-Error 'Creation stopped. Partial database files were preserved for diagnosis and were not deleted.'
        throw
    }
    finally {
        foreach ($name in @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD')) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        $ownerPassword = $null
        $appPassword = $null
        $securityKey = $null
        $mfaKey = $null
    }
    exit 0
}

$resolvedPgBin = Resolve-PgBin -Required $true
if (-not (Test-Path -LiteralPath $dataPath)) { throw 'The local database has not been created yet.' }

if ($Action -eq 'Start') {
    Start-LocalDatabase -ResolvedPgBin $resolvedPgBin
    exit 0
}
if ($Action -eq 'Status') {
    if (Test-DatabaseRunning -ResolvedPgBin $resolvedPgBin) {
        if (-not (Test-Path -LiteralPath $ownerEnvPath)) { throw 'Protected database owner settings are missing.' }
        $ownerSettings = Read-EnvironmentFile -Path $ownerEnvPath
        foreach ($name in @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD')) {
            if (-not $ownerSettings.ContainsKey($name)) { throw "Database settings are missing $name." }
            Set-Item -LiteralPath "Env:$name" -Value $ownerSettings[$name]
        }
        try {
            $facts = & (Join-Path $resolvedPgBin 'psql.exe') '-w' '-tA' '-c' "select (select count(*) from meal.schema_migrations),(select name from meal.environment);"
            if ($LASTEXITCODE -ne 0 -or $facts.Trim() -ne '42|development') { throw 'The database is running, but its schema is not ready.' }
        }
        finally {
            foreach ($name in @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD')) {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
        }
        Write-Output "The local development database is running at 127.0.0.1:$port with 42 migrations applied."
        exit 0
    }
    Write-Output 'The local database is stopped.'
    exit 1
}
if ($Action -eq 'Stop') {
    if (-not (Test-DatabaseRunning -ResolvedPgBin $resolvedPgBin)) {
        Write-Output 'The local database is already stopped.'
        exit 0
    }
    & (Join-Path $resolvedPgBin 'pg_ctl.exe') stop '-D' $dataPath '-m' fast '-w' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the local database.' }
    Write-Output 'The local database is stopped. Its data was preserved.'
}

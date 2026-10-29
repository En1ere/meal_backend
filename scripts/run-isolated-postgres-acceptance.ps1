[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Iterations = 3,
    [string]$PgBin = '',
    [string]$PrivateRoot = '',
    [string]$EvidenceRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $PgBin) { throw 'Provide -PgBin pointing to PostgreSQL 18 binaries.' }
$backRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $PrivateRoot) { $PrivateRoot = 'D:\AITemp\meal-backend-postgres-acceptance' }
$privateRoot = [IO.Path]::GetFullPath($PrivateRoot)
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $privateRoot 'acceptance-postgres'))
$qaRoot = [IO.Path]::GetFullPath((Join-Path $privateRoot 'evidence'))
$prettier = Join-Path $backRoot 'node_modules\.bin\prettier.cmd'
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $qaRoot 'postgres-acceptance\iterations' }
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$port = 54329

if (-not $runtimeRoot.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing a runtime path outside the dedicated private directory.'
}
if ([IO.Path]::GetFileName($runtimeRoot) -ne 'acceptance-postgres') {
    throw 'Unexpected runtime directory name.'
}
if (-not $EvidenceRoot.StartsWith($qaRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing an evidence path outside the dedicated evidence directory.'
}
foreach ($executable in @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'psql.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PgBin $executable))) {
        throw "Missing PostgreSQL executable: $executable"
    }
}
if (-not (Test-Path -LiteralPath $prettier)) {
    throw 'Local Prettier executable is required to persist lint-clean acceptance evidence.'
}
if ((& (Join-Path $PgBin 'psql.exe') --version) -notmatch 'PostgreSQL\) 18\.') {
    throw 'PostgreSQL 18 is required.'
}

function New-HexSecret {
    $bytes = [byte[]]::new(32)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Remove-AcceptanceRuntime {
    param([string]$DataPath)
    if (Test-Path -LiteralPath $DataPath) {
        & (Join-Path $PgBin 'pg_ctl.exe') stop '-D' $DataPath '-m' fast '-w' 2>$null | Out-Null
    }
    if (Test-Path -LiteralPath $runtimeRoot) {
        $resolved = [IO.Path]::GetFullPath($runtimeRoot)
        if ($resolved -ne $runtimeRoot -or -not $resolved.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to remove an unverified PostgreSQL runtime path.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is occupied. No existing PostgreSQL process will be reused or stopped."
}
if (Test-Path -LiteralPath $runtimeRoot) {
    throw "Temporary runtime already exists: $runtimeRoot"
}

Push-Location $backRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
    New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
    $sourceVersion = (Get-Content -LiteralPath (Join-Path $backRoot 'package.json') -Raw | ConvertFrom-Json).version
    $postgresVersion = (& (Join-Path $PgBin 'psql.exe') --version).Trim()

    for ($iteration = 1; $iteration -le $Iterations; $iteration += 1) {
        $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
        $dataPath = Join-Path $runtimeRoot 'data'
        $passwordPath = Join-Path $runtimeRoot 'owner-password.txt'
        $logPath = Join-Path $runtimeRoot 'postgres.log'
        $ownerPassword = New-HexSecret
        $appPassword = New-HexSecret
        try {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            & icacls.exe $runtimeRoot '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)F" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: private runtime ACL failed." }
            [IO.File]::WriteAllText($passwordPath, $ownerPassword, [Text.UTF8Encoding]::new($false))

            & (Join-Path $PgBin 'initdb.exe') '-D' $dataPath '-U' 'meal_owner' '--encoding=UTF8' '--locale=C' '--auth=scram-sha-256' "--pwfile=$passwordPath" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: initdb failed." }
            Remove-Item -LiteralPath $passwordPath -Force

            $ctlArgs = @(
                'start',
                '-D', ('"' + $dataPath + '"'),
                '-l', ('"' + $logPath + '"'),
                '-o', '"-h 127.0.0.1 -p 54329 -c timezone=UTC -c log_timezone=UTC"',
                '-w'
            )
            $start = Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList $ctlArgs -WindowStyle Hidden -PassThru
            if (-not $start.WaitForExit(60000)) { throw "Iteration ${iteration}: pg_ctl start timed out." }
            if ($start.ExitCode -ne 0) { throw "Iteration ${iteration}: PostgreSQL start failed." }

            $env:PGHOST = '127.0.0.1'
            $env:PGHOSTADDR = '127.0.0.1'
            $env:PGPORT = [string]$port
            $env:PGUSER = 'meal_owner'
            $env:PGDATABASE = 'meal_planner_postgres'
            $env:PGPASSWORD = $ownerPassword
            & (Join-Path $PgBin 'createdb.exe') '-w' '--template=template0' '--encoding=UTF8' '--locale=C' 'meal_planner_postgres'
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: createdb failed." }

            & node scripts/migrate.mjs --apply --environment=test
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: migration failed." }

            $billingFixtures = "BEGIN ISOLATION LEVEL SERIALIZABLE; INSERT INTO meal.billing_products(id,code,kind,features) VALUES ('00000000-0000-4000-8000-000000000101','plus','subscription','{}'::jsonb),('00000000-0000-4000-8000-000000000102','pro','subscription','{}'::jsonb) ON CONFLICT(code) DO NOTHING; COMMIT;"
            & (Join-Path $PgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-c' $billingFixtures | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: billing fixture creation failed." }

            $createRole = "CREATE ROLE meal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '$appPassword'; GRANT CONNECT ON DATABASE meal_planner_postgres TO meal_app; GRANT USAGE ON SCHEMA meal TO meal_app;"
            & (Join-Path $PgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-c' $createRole | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: application role creation failed." }
            & (Join-Path $PgBin 'psql.exe') '-w' '-v' 'ON_ERROR_STOP=1' '-f' (Join-Path $backRoot 'database\application-grants.sql') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: application grants failed." }

            $env:DATABASE_URL = "postgresql://meal_app:$appPassword@127.0.0.1:$port/meal_planner_postgres"
            $env:ACCEPTANCE_OWNER_DATABASE_URL = "postgresql://meal_owner:$ownerPassword@127.0.0.1:$port/meal_planner_postgres"
            $acceptanceOutput = @(& node --expose-gc scripts/test-postgres-live.mjs 2>&1)
            $acceptanceExitCode = $LASTEXITCODE
            $acceptanceOutput | ForEach-Object { Write-Output $_ }
            if ($acceptanceExitCode -ne 0) {
                $failureRoot = Join-Path $EvidenceRoot "I${iteration}"
                New-Item -ItemType Directory -Path $failureRoot -Force | Out-Null
                [IO.File]::WriteAllLines(
                    (Join-Path $failureRoot 'stdout.failed.log'),
                    [string[]]($acceptanceOutput | ForEach-Object { [string]$_ }),
                    [Text.UTF8Encoding]::new($false)
                )
                throw "Iteration ${iteration}: live acceptance failed. See $failureRoot\stdout.failed.log"
            }
            $evidenceLines = @($acceptanceOutput | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('ACCEPTANCE_EVIDENCE ') })
            if ($evidenceLines.Count -ne 1) { throw "Iteration ${iteration}: expected exactly one ACCEPTANCE_EVIDENCE line." }
            $workflowEvidence = $evidenceLines[0].Substring('ACCEPTANCE_EVIDENCE '.Length) | ConvertFrom-Json
            if ($workflowEvidence.schema -ne 'inventory-live-happy-path-v1') {
                throw "Iteration ${iteration}: unsupported acceptance evidence schema."
            }
            $supplementalEvidence = [ordered]@{}
            foreach ($item in @(
                @{ Prefix = 'CORE_DOMAIN_ACCEPTANCE_EVIDENCE '; Key = 'coreDomain'; Schema = 'core-domain-live-happy-path-v1' },
                @{ Prefix = 'CATALOG_RECIPE_SEARCH_EVIDENCE '; Key = 'catalogRecipeSearch'; Schema = 'catalog-recipe-search-live-happy-path-v1' },
                @{ Prefix = 'COMMUNITY_ACCEPTANCE_EVIDENCE '; Key = 'community'; Schema = 'community-live-happy-path-v1' },
                @{ Prefix = 'SUPPORT_ACCEPTANCE_EVIDENCE '; Key = 'support'; Schema = 'support-live-happy-path-v1' },
                @{ Prefix = 'FINANCE_ACCEPTANCE_EVIDENCE '; Key = 'finance'; Schema = 'finance-live-happy-path-v1' },
                @{ Prefix = 'NOTIFICATIONS_ACCEPTANCE_EVIDENCE '; Key = 'notifications'; Schema = 'notifications-live-happy-path-v1' },
                @{ Prefix = 'ADMIN_DOMAIN_ACCEPTANCE_EVIDENCE '; Key = 'adminDomain'; Schema = 'admin-free-ai-live-v1' },
                @{ Prefix = 'ADMIN_BILLING_ACCEPTANCE_EVIDENCE '; Key = 'adminBilling'; Schema = 'admin-billing-live-v1' },
                @{ Prefix = 'ADMIN_OPERATIONS_ACCEPTANCE_EVIDENCE '; Key = 'adminOperations'; Schema = 'admin-operations-live-v1' },
                @{ Prefix = 'ADMIN_EXACT_ACCEPTANCE_EVIDENCE '; Key = 'adminExact'; Schema = 'admin-domain-live-v1' },
                @{ Prefix = 'AUTH_ACCEPTANCE_EVIDENCE '; Key = 'staffAuth'; Schema = 'admin-staff-auth-live-v1' },
                @{ Prefix = 'FAMILY_ACCEPTANCE_EVIDENCE '; Key = 'family'; Schema = 'family-live-happy-path-v1' },
                @{ Prefix = 'QUERY_OPTIMIZATIONS_EVIDENCE '; Key = 'queryOptimizations'; Schema = 'query-optimizations-live-v1' },
                @{ Prefix = 'RECIPE_WORKSPACE_ACCEPTANCE_EVIDENCE '; Key = 'recipeWorkspace'; Schema = 'recipe-workspace-live-v1' },
                @{ Prefix = 'RECIPE_LIFECYCLE_ACCEPTANCE_EVIDENCE '; Key = 'recipeLifecycle'; Schema = 'recipe-revision-lifecycle-live-v1' },
                @{ Prefix = 'SHOPPING_RECEIPTS_ACCEPTANCE_EVIDENCE '; Key = 'shoppingReceipts'; Schema = 'shopping-receipts-live-v1' },
                @{ Prefix = 'PLANNING_PRESERVES_COOKING_EVIDENCE '; Key = 'planningPreservesCooking'; Schema = 'planning-preserves-cooking-live-v1' },
                @{ Prefix = 'AI_PRO_DOMAIN_ACCEPTANCE_EVIDENCE '; Key = 'aiProDomain'; Schema = 'ai-pro-domain-live-v1' },
                @{ Prefix = 'REMAINING_DOMAINS_ACCEPTANCE_EVIDENCE '; Key = 'remainingDomains'; Schema = 'remaining-domains-live-v1' },
                @{ Prefix = 'ACCOUNT_LIFECYCLE_ACCEPTANCE_EVIDENCE '; Key = 'accountLifecycle'; Schema = 'account-lifecycle-live-v1' }
            )) {
                $matches = @($acceptanceOutput | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith($item.Prefix) })
                if ($matches.Count -ne 1) { throw "Iteration ${iteration}: expected exactly one $($item.Prefix.Trim()) line." }
                $parsed = $matches[0].Substring($item.Prefix.Length) | ConvertFrom-Json
                if ($parsed.schema -ne $item.Schema) { throw "Iteration ${iteration}: unsupported $($item.Key) evidence schema." }
                $supplementalEvidence[$item.Key] = $parsed
            }
            $iterationRoot = Join-Path $EvidenceRoot "I${iteration}"
            New-Item -ItemType Directory -Path $iterationRoot -Force | Out-Null
            $result = [ordered]@{
                version = 1
                status = 'passed'
                iteration = "I${iteration}"
                sourceVersion = $sourceVersion
                startedAt = $startedAt
                finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
                postgresVersion = $postgresVersion
                evidence = $workflowEvidence
                supplementalEvidence = $supplementalEvidence
            }
            $resultPath = Join-Path $iterationRoot 'results.json'
            [IO.File]::WriteAllText(
                $resultPath,
                (($result | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
                [Text.UTF8Encoding]::new($false)
            )
            & $prettier '--write' $resultPath | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Iteration ${iteration}: evidence formatting failed." }
            [IO.File]::WriteAllLines(
                (Join-Path $iterationRoot 'stdout.log'),
                [string[]]($acceptanceOutput | ForEach-Object { [string]$_ }),
                [Text.UTF8Encoding]::new($false)
            )
            Write-Output "Isolated PostgreSQL acceptance iteration $iteration/$Iterations passed."
        }
        finally {
            $env:DATABASE_URL = $null
            $env:ACCEPTANCE_OWNER_DATABASE_URL = $null
            $env:PGPASSWORD = $null
            $ownerPassword = $null
            $appPassword = $null
            Remove-AcceptanceRuntime -DataPath $dataPath
        }
    }
}
finally {
    Pop-Location
    foreach ($name in @('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'DATABASE_URL', 'ACCEPTANCE_OWNER_DATABASE_URL')) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $privateRoot) -and -not (Get-ChildItem -LiteralPath $privateRoot -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $privateRoot -Force
    }
}

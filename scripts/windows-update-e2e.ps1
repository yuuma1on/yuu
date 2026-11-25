# Exercises the production updater on a disposable GitHub-hosted Windows runner.
# The public target installer is never launched by this script. Only the installed
# baseline app downloads, authenticates, and launches that installer.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
    [string] $TargetVersion,

    [Parameter(Mandatory)]
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
    [string] $BaselineVersion,

    [switch] $PublishedBaseline,

    [Parameter(Mandatory)]
    [string] $ReportDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Run this installation test on a disposable GitHub Actions Windows runner.'
}
if ($env:GITHUB_REPOSITORY -cne 'yuuma1on/yuu') {
    throw 'This test uses only the yuuma1on/yuu public release feed.'
}

$repository = Split-Path -Parent $PSScriptRoot
$reportRoot = [System.IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
# The smoke CLI explicitly permits the runner's temporary root; Windows and
# Electron may otherwise select different system temporary directories.
$testRoot = Join-Path $env:RUNNER_TEMP "pulse-update-e2e-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if (Test-Path $testRoot) { throw 'The E2E temporary directory already exists.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$installRoot = Join-Path $testRoot 'installed'
$executable = Join-Path $installRoot 'PULSE.exe'
$report = [ordered]@{
    ok = $false
    repository = 'yuuma1on/yuu'
    sourceCommit = $env:GITHUB_SHA
    baselineKind = $(if ($PublishedBaseline) { 'Authenticated published release' } else { 'Current source stamped with a throwaway lower version' })
    baselineVersion = $BaselineVersion
    targetVersion = $TargetVersion
    productionFeed = 'https://github.com/yuuma1on/yuu/releases/latest/download/pulse-update.json'
    startedAt = [DateTime]::UtcNow.ToString('o')
    directTargetInstallerLaunch = $false
}
$packagePath = Join-Path $repository 'package.json'
$lockPath = Join-Path $repository 'package-lock.json'
$originalPackage = [System.IO.File]::ReadAllBytes($packagePath)
$originalLock = [System.IO.File]::ReadAllBytes($lockPath)

function Write-JsonReport([string] $Name, $Value) {
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $reportRoot $Name) -Encoding utf8
}

function Get-InstalledVersions {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
    try {
        $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
        return @{ fileVersion = $info.FileVersion; productVersion = $info.ProductVersion }
    } catch { return $null }
}

function Test-PeVersion($Versions, [string] $Expected) {
    if ($null -eq $Versions) { return $false }
    $pattern = '^' + [regex]::Escape($Expected) + '(\.0)?$'
    return $Versions.fileVersion -cmatch $pattern -or $Versions.productVersion -cmatch $pattern
}

function Stop-TestApp {
    Get-Process -Name 'PULSE' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Path -and $_.Path.StartsWith($installRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-DemoSmoke([string] $ExpectedVersion, [string] $Label) {
    $output = Join-Path $testRoot "$Label.json"
    if (Test-Path $output) { throw 'Smoke output must be a new file.' }
    $process = Start-Process -FilePath $executable -ArgumentList @('--smoke-test', ('"--smoke-output={0}"' -f $output)) -PassThru
    if (-not $process.WaitForExit(45000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "$Label timed out."
    }
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
        throw "$Label failed to return a successful smoke result."
    }
    $result = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    Write-JsonReport "$Label.json" $result
    if ($result.ok -ne $true -or $result.appVersion -cne $ExpectedVersion -or $result.nodeAvailable -ne $false -or $result.secureContext -ne $true -or $result.workerAvailable -ne $true -or $result.desktopBridge -ne $true -or [Math]::Abs([double]$result.bpm - 120) -ge 0.05) {
        throw "$Label did not prove the expected version, sandbox, secure context, and demo analysis."
    }
    if ($null -ne $result.PSObject.Properties['displayedVersion'] -and $result.displayedVersion -cne "v$ExpectedVersion") {
        throw "$Label did not display the installed version."
    }
    return $result
}

function Invoke-RegionalSmoke([string] $ExpectedVersion, [string] $Label) {
    $output = Join-Path $testRoot "$Label.json"
    if (Test-Path $output) { throw 'Regional smoke output must be a new file.' }
    $process = Start-Process -FilePath $executable -ArgumentList @('--regional-smoke-test', ('"--smoke-output={0}"' -f $output)) -PassThru
    if (-not $process.WaitForExit(150000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "$Label timed out."
    }
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "$Label failed." }
    $result = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    Write-JsonReport "$Label.json" $result
    if ($result.ok -ne $true -or $result.appVersion -cne $ExpectedVersion -or $result.displayedVersion -cne "v$ExpectedVersion" -or $result.nodeAvailable -ne $false -or $result.secureContext -ne $true -or $result.regionalCandidates -lt 1 -or $result.fullTrackTimingEmpty -ne $true -or $result.tjaGuarded -ne $true -or $result.tjaDownloads -ne 0 -or $result.progressMonotonic -ne $true -or $result.referenceDidNotMutateAnalysis -ne $true) {
        throw "$Label did not prove regional candidates and TJA guards in the updated installed app."
    }
    if ($result.localReferenceMatched -ne $true -or $result.localReferenceMatchingSeconds -ne 4 -or $result.referenceComparisonVisible -ne $true -or $result.wholeTrackCoveragePercent -ne 0 -or $result.wholeTrackDirectAgreementPercent -ne 0) {
        throw "$Label did not prove the actual local reference match without inflating full-track coverage."
    }
    return $result
}

Push-Location $repository
try {
    Write-Host "Checking the public authenticated release feed for $TargetVersion."
    $preflightProgram = @'
const fs = require('node:fs');
const {MANIFEST_URL, fetchReleaseBytes, verifyEnvelope, verifyBytes, verifyUpdateInfo} = require('./desktop/update-manifest.cjs');
(async () => {
  const target = process.argv[1], baseline = process.argv[2];
  const raw = await fetchReleaseBytes(MANIFEST_URL, {maxBytes: 65536});
  const signed = verifyEnvelope(raw, fs.readFileSync('./desktop/update-public-key.pem'), {currentVersion: baseline});
  if (!signed.newer || signed.manifest.version !== target) throw new Error('The public stable/latest release must match the requested target and be newer than the baseline.');
  const metadata = await fetchReleaseBytes(signed.feedUrl + 'latest.yml', {maxBytes: 65536});
  verifyBytes(metadata, signed.manifest.latestYml);
  verifyUpdateInfo(require('yaml').parse(metadata.toString('utf8')), signed.manifest);
  console.log(JSON.stringify({signatureVerified: true, metadataVerified: true, targetVersion: signed.manifest.version, installerName: signed.manifest.installer.name, installerSha512: signed.manifest.installer.sha512, installerSize: signed.manifest.installer.size, publishedAt: signed.manifest.publishedAt}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@
    $preflightOutput = & node --input-type=commonjs -e $preflightProgram $TargetVersion $BaselineVersion
    if ($LASTEXITCODE -ne 0) { throw 'Public signed-release preflight failed. Publish the target stable/latest release first.' }
    $report.preflight = ($preflightOutput -join "`n") | ConvertFrom-Json
    Write-JsonReport 'preflight.json' $report.preflight

    if ($PublishedBaseline) {
        Write-Host "Authenticating the real published $BaselineVersion installer."
        $baselineDirectory = Join-Path $testRoot 'published-baseline'
        New-Item -ItemType Directory -Path $baselineDirectory | Out-Null
        $publishedProgram = @'
const fs = require('node:fs/promises');
const path = require('node:path');
const {fetchReleaseBytes, verifyEnvelope, verifyBytes, verifyUpdateInfo, verifyInstaller} = require('./desktop/update-manifest.cjs');
(async () => {
  const version = process.argv[1], directory = process.argv[2];
  const base = `https://github.com/yuuma1on/yuu/releases/download/v${version}/`;
  const envelope = await fetchReleaseBytes(base + 'pulse-update.json', {maxBytes: 65536});
  const signed = verifyEnvelope(envelope, await fs.readFile('./desktop/update-public-key.pem'), {currentVersion: '0.0.0'});
  if (signed.manifest.version !== version || signed.feedUrl !== base) throw new Error('Published baseline version does not match its authenticated envelope.');
  const metadata = await fetchReleaseBytes(base + 'latest.yml', {maxBytes: 65536});
  verifyBytes(metadata, signed.manifest.latestYml);
  verifyUpdateInfo(require('yaml').parse(metadata.toString('utf8')), signed.manifest);
  const artifact = signed.manifest.installer;
  const filename = path.join(directory, artifact.name);
  const bytes = await fetchReleaseBytes(artifact.url, {maxBytes: artifact.size, timeoutMs: 120000});
  await fs.writeFile(filename, bytes, {flag: 'wx'});
  await verifyInstaller(filename, artifact, directory);
  console.log(JSON.stringify({version, signatureVerified: true, metadataVerified: true, installerVerified: true, installerName: artifact.name, installerSha512: artifact.sha512, installerSize: artifact.size}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@
        $publishedOutput = & node --input-type=commonjs -e $publishedProgram $BaselineVersion $baselineDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Published baseline authentication or exact installer download failed.' }
        $report.publishedBaseline = ($publishedOutput -join "`n") | ConvertFrom-Json
        Write-JsonReport 'published-baseline.json' $report.publishedBaseline
        $baselineInstaller = Join-Path $baselineDirectory "PULSE-Setup-$BaselineVersion-x64.exe"
    } else {
        Write-Host "Building a disposable $BaselineVersion baseline; no release is created."
        & npm version $BaselineVersion --no-git-tag-version --ignore-scripts --allow-same-version
        if ($LASTEXITCODE -ne 0) { throw 'Could not stamp the throwaway baseline version.' }
        & npm run build:win
        if ($LASTEXITCODE -ne 0) { throw 'Throwaway baseline build failed.' }
        $baselineInstaller = Join-Path $repository "dist/PULSE-Setup-$BaselineVersion-x64.exe"
    }
    if (-not (Test-Path -LiteralPath $baselineInstaller -PathType Leaf)) { throw 'Baseline installer is missing.' }
    $report.baselineInstallerSha256 = (Get-FileHash -LiteralPath $baselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Host "Installing baseline $BaselineVersion."
    $setup = Start-Process -FilePath $baselineInstaller -ArgumentList @('/S', "/D=$installRoot") -PassThru
    if (-not $setup.WaitForExit(120000)) {
        Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue
        throw 'Baseline installation timed out.'
    }
    if ($setup.ExitCode -ne 0) { throw "Baseline installer failed: $($setup.ExitCode)" }
    $report.installedBefore = Get-InstalledVersions
    if (-not (Test-PeVersion $report.installedBefore $BaselineVersion)) { throw 'Installed PE version does not match the baseline.' }
    $report.baselineSmoke = Invoke-DemoSmoke $BaselineVersion 'baseline-smoke'

    Write-Host "Starting the installed $BaselineVersion app's production authenticated updater."
    $updateOutput = Join-Path $testRoot 'update-smoke.json'
    $old = Start-Process -FilePath $executable -ArgumentList @('--update-smoke-test', ('"--smoke-output={0}"' -f $updateOutput)) -PassThru
    $report.updaterStartedAt = [DateTime]::UtcNow.ToString('o')
    if (-not $old.WaitForExit(600000)) {
        Stop-Process -Id $old.Id -Force -ErrorAction SilentlyContinue
        throw 'Authenticated download/install request timed out.'
    }
    if ($old.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $updateOutput -PathType Leaf)) {
        throw 'The installed old app failed its authenticated update smoke test.'
    }
    $updateResult = Get-Content -LiteralPath $updateOutput -Raw | ConvertFrom-Json
    Write-JsonReport 'update-smoke.json' $updateResult
    $report.update = $updateResult
    if ($updateResult.ok -ne $true -or $updateResult.fromVersion -cne $BaselineVersion -or $updateResult.targetVersion -cne $TargetVersion -or $updateResult.authenticated -ne $true -or $updateResult.installerLaunched -ne $true) {
        throw 'The updater did not prove an authenticated install request for the expected upgrade.'
    }

    Write-Host 'Waiting for the updater-launched installer to replace the installed executable.'
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    $attempt = 0
    $lastSmokeError = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $versions = Get-InstalledVersions
        if (Test-PeVersion $versions $TargetVersion) {
            $attempt++
            try {
                $finalSmoke = Invoke-DemoSmoke $TargetVersion "updated-smoke-$attempt"
                if ($finalSmoke.regionalSmokeAvailable -eq $true) {
                    $report.updatedRegionalSmoke = Invoke-RegionalSmoke $TargetVersion "updated-regional-smoke-$attempt"
                }
                $report.installedAfter = $versions
                $report.updatedSmoke = $finalSmoke
                break
            } catch {
                # NSIS replacement is asynchronous; a new PE version may appear
                # before every packaged resource has been replaced.
                $lastSmokeError = $_.Exception.Message
                Stop-TestApp
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $report.Contains('updatedSmoke')) {
        throw "Updated installed app never passed its independent demo smoke test. $lastSmokeError"
    }
    $report.ok = $true
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    Write-Host "Verified real installed update $BaselineVersion -> $TargetVersion with successful demo analysis."
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    Stop-TestApp
    [System.IO.File]::WriteAllBytes($packagePath, $originalPackage)
    [System.IO.File]::WriteAllBytes($lockPath, $originalLock)
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-JsonReport 'update-e2e-proof.json' $report
    Pop-Location
}

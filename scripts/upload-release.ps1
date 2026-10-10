$ErrorActionPreference = 'Stop'
# Check native exit codes explicitly, including when pwsh enables this preference.
$PSNativeCommandUseErrorActionPreference = $false
$maxAttempts = 3

function Read-GitHubJson([string[]] $Arguments) {
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $raw = & gh @Arguments
    if ($LASTEXITCODE -eq 0) { return (($raw -join [Environment]::NewLine) | ConvertFrom-Json) }
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds $attempt }
  }
  throw 'Cannot inspect GitHub release metadata; retained local and uploaded assets can be reused'
}

function Assert-Draft($Release) {
  if ($Release.tag_name -ne $tag -or $Release.draft -ne $true) {
    throw 'This tag is already published or the destination changed; published assets must never be overwritten'
  }
}

function Read-Draft {
  $release = Read-GitHubJson -Arguments @('api', "repos/$repository/releases/$releaseId")
  Assert-Draft $release
  if ($release.id -ne $releaseId) { throw 'Release identity changed unexpectedly' }
  return $release
}

function Find-Asset($Release, [string] $Name) {
  $matches = @($Release.assets | Where-Object { $_.name -ceq $Name })
  if ($matches.Count -gt 1) { throw "Duplicate remote assets: $Name" }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Test-VerifiedAsset($Remote, $Local) {
  return ($null -ne $Remote -and $Remote.state -ceq 'uploaded' -and
    $Remote.size -eq $Local.size -and $Remote.digest -ieq "sha256:$($Local.sha256)")
}

$tag = $env:RELEASE_TAG
$repository = $env:GITHUB_REPOSITORY
if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'GITHUB_REPOSITORY must be owner/repository' }
$report = Get-Content -LiteralPath 'test/results/release-artifacts.json' -Raw | ConvertFrom-Json
if ($tag -ne "v$($report.version)") { throw 'Verified source version differs from the release tag' }
$items = @($report.executable, $report.blockmap, $report.latest)
$names = @($items | ForEach-Object { $_.file })
if (@($report.assets).Count -ne 3 -or @($names | Select-Object -Unique).Count -ne 3 -or
    @(Compare-Object -ReferenceObject $names -DifferenceObject @($report.assets) -CaseSensitive).Count -ne 0) {
  throw 'Expected exactly the verified EXE, blockmap, and latest.yml'
}
$localAssets = foreach ($item in $items) {
  if (-not $item.file -or $item.file -match '[/\\:]' -or $item.file -in @('.', '..')) { throw 'Unsafe asset path' }
  if ($item.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid artifact digest: $($item.file)" }
  $file = Join-Path 'dist' $item.file
  $local = Get-Item -LiteralPath $file
  if ($local.PSIsContainer -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $item.sha256) {
    throw "Artifact hash mismatch: $file"
  }
  [PSCustomObject]@{ name = $item.file; file = $file; sha256 = $item.sha256; size = $local.Length }
}

# Read every release page so an existing published tag is never mistaken for a new draft.
$pages = Read-GitHubJson -Arguments @('api', '--paginate', '--slurp', "repos/$repository/releases?per_page=100")
$matching = @($pages | ForEach-Object { $_ } | Where-Object { $_.tag_name -eq $tag })
if ($matching.Count -gt 1) { throw 'Duplicate releases exist for this tag; resolve them before uploading' }
if ($matching.Count -eq 1) { Assert-Draft $matching[0] }
else {
  & gh release create $tag --repo $repository --draft --verify-tag --title "Pi Halo $($report.version)" --notes 'Verified Windows installer; final publication pending.'
  # An interrupted response may still have created the draft. Re-read before any retry.
  $pages = Read-GitHubJson -Arguments @('api', '--paginate', '--slurp', "repos/$repository/releases?per_page=100")
  $matching = @($pages | ForEach-Object { $_ } | Where-Object { $_.tag_name -eq $tag })
  if ($matching.Count -ne 1) { throw 'Cannot identify the draft release after creation; retry with retained artifacts' }
  Assert-Draft $matching[0]
}
$releaseId = $matching[0].id
if (-not $releaseId) { throw 'Missing draft release identity' }
$snapshot = Read-Draft
$uploadedCount = 0
$skippedCount = 0
foreach ($local in $localAssets) {
  $remote = Find-Asset $snapshot $local.name
  if (Test-VerifiedAsset $remote $local) {
    Write-Output "Reusing verified remote asset: $($local.name)"
    $skippedCount++
    continue
  }
  $verified = $false
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    # Recheck immediately before each mutation, including failed-upload retries.
    $snapshot = Read-Draft
    $remote = Find-Asset $snapshot $local.name
    if (Test-VerifiedAsset $remote $local) { $verified = $true; break }
    $arguments = @('release', 'upload', $tag, $local.file, '--repo', $repository)
    if ($null -ne $remote) { $arguments += '--clobber' }
    Write-Output "Uploading $($local.name) (attempt $attempt/$maxAttempts)"
    & gh @arguments
    $uploadExit = $LASTEXITCODE
    # Never blindly resend: the server may have accepted the file before the connection failed.
    $snapshot = Read-Draft
    $remote = Find-Asset $snapshot $local.name
    if ($null -ne $remote -and $remote.state -ceq 'uploaded' -and $remote.size -eq $local.size -and -not $remote.digest) {
      # Wait for metadata only; do not retransmit a large EXE merely because its digest is delayed.
      for ($poll = 1; $poll -le $maxAttempts -and -not $remote.digest; $poll++) {
        Start-Sleep -Seconds $poll
        $snapshot = Read-Draft
        $remote = Find-Asset $snapshot $local.name
      }
      if ($null -ne $remote -and -not $remote.digest) { throw "GitHub has not supplied a digest for $($local.name); retry verification later with retained artifacts" }
    }
    if (Test-VerifiedAsset $remote $local) { $verified = $true; $uploadedCount++; break }
    if ($attempt -lt $maxAttempts) {
      Write-Warning "Asset not verified after upload (exit $uploadExit): $($local.name); retrying only this asset"
      Start-Sleep -Seconds $attempt
    }
  }
  if (-not $verified) { throw "Release asset failed digest/size/state verification after $maxAttempts attempts: $($local.name)" }
}

$snapshot = Read-Draft
foreach ($local in $localAssets) {
  if (-not (Test-VerifiedAsset (Find-Asset $snapshot $local.name) $local)) {
    throw "Final remote asset verification failed: $($local.name)"
  }
}
Write-Output "Verified all three assets in draft $tag (uploaded: $uploadedCount; reused: $skippedCount)"

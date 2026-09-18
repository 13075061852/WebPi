$ErrorActionPreference = 'Stop'
$report = Get-Content -LiteralPath 'test/results/release-artifacts.json' -Raw | ConvertFrom-Json
foreach ($item in @($report.executable, $report.blockmap, $report.latest)) {
  if ([IO.Path]::GetFileName($item.file) -ne $item.file) { throw 'Unsafe asset path' }
  $file = Join-Path 'dist' $item.file
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw "Artifact hash mismatch: $file" }
}
$ErrorActionPreference = 'Stop'
$tag = $env:RELEASE_TAG
$report = Get-Content -LiteralPath 'test/results/release-artifacts.json' -Raw | ConvertFrom-Json
if ($tag -ne "v$($report.version)") { throw 'Verified source version differs from the release tag' }
$pagesJson = gh api --paginate --slurp "repos/$env:GITHUB_REPOSITORY/releases?per_page=100"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing releases' }
$pages = ($pagesJson -join [Environment]::NewLine) | ConvertFrom-Json
$matching = @($pages | ForEach-Object { $_ } | Where-Object { $_.tag_name -eq $tag })
if ($matching.Count -gt 1) { throw 'Duplicate releases exist for this tag; resolve them before uploading' }
if ($matching.Count -eq 1 -and -not $matching[0].draft) { throw 'This tag is already published; use a new version for changed installer bytes' }
if ($matching.Count -eq 0) {
  gh release create $tag --draft --verify-tag --title "Pi Halo $($report.version)" --notes 'Windows 安装包已通过自动校验，等待最终发布。'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create draft release' }
}
$assets = @($report.assets | ForEach-Object { Join-Path 'dist' $_ })
if ($assets.Count -ne 3) { throw 'Expected the verified EXE, blockmap, and latest.yml' }
gh release upload $tag @assets --clobber
if ($LASTEXITCODE -ne 0) { throw 'Release asset upload failed' }
$uploadedJson = gh release view $tag --json tagName,isDraft,assets
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the draft release after upload' }
$uploaded = ($uploadedJson -join [Environment]::NewLine) | ConvertFrom-Json
if (-not $uploaded.isDraft -or $uploaded.tagName -ne $tag) { throw 'Upload destination changed unexpectedly' }
foreach ($name in $report.assets) {
  $remote = @($uploaded.assets | Where-Object { $_.name -eq $name })
  $local = Get-Item -LiteralPath (Join-Path 'dist' $name)
  if ($remote.Count -ne 1 -or $remote[0].size -ne $local.Length) { throw "Uploaded asset is missing or incomplete: $name" }
}
Write-Output "Verified all three assets in draft $tag"

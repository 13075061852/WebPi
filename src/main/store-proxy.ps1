$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$packageFamily = 'Microsoft.WindowsStore_8wekyb3d8bbwe'
$packageSid = 'S-1-15-2-1609473798-1231923017-684268153-4268514328-882773646-2760585773-1760938157'
$tool = Join-Path $env:SystemRoot 'System32\CheckNetIsolation.exe'

function Read-StoreProxy {
  $package = Get-AppxPackage -Name 'Microsoft.WindowsStore' -ErrorAction Stop | Where-Object { $_.PackageFamilyName -eq $packageFamily }
  if (!$package) { return @{ supported = $true; installed = $false; enabled = $false } }
  if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'tool-unavailable' }
  $listing = (& $tool LoopbackExempt -s 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'read-failed' }
  # Package family and SID are invariant across localized command output. Only
  # accept whole tokens, never another application's prefix or an error message.
  $pattern = '(?im)(?<![\w.-])(?:' + [regex]::Escape($packageFamily) + '|' + [regex]::Escape($packageSid) + ')(?![\w.-])'
  return @{ supported = $true; installed = $true; enabled = [bool]($listing -match $pattern) }
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -notin @('status', 'repair')) { throw 'invalid-action' }
  $state = Read-StoreProxy
  if ($request.action -eq 'repair' -and !$state.enabled) {
    if (!$state.installed) { throw 'not-installed' }
    # The elevated executable and every argument are fixed here. No command,
    # package family or executable path can be supplied by the renderer.
    $process = Start-Process -FilePath $tool -ArgumentList @('LoopbackExempt', '-a', '-n=Microsoft.WindowsStore_8wekyb3d8bbwe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -eq 1223) { throw 'cancelled' }
    if ($process.ExitCode -ne 0) { throw 'repair-failed' }
    $state = Read-StoreProxy
    if (!$state.enabled) { throw 'verify-failed' }
  }
  $state | ConvertTo-Json -Compress
} catch {
  $errorCode = 'read-failed'
  if ($request.action -eq 'repair') { $errorCode = 'repair-failed' }
  if ($_.Exception.Message -in @('cancelled', 'not-installed', 'tool-unavailable', 'read-failed', 'repair-failed', 'verify-failed')) { $errorCode = $_.Exception.Message }
  $cause = $_.Exception
  while ($null -ne $cause) {
    if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { $errorCode = 'cancelled'; break }
    $cause = $cause.InnerException
  }
  @{ error = $errorCode } | ConvertTo-Json -Compress
  exit 1
}

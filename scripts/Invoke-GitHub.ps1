# Local GitHub launcher. Never writes credentials to disk.
# Examples:
#   & ./scripts/Invoke-GitHub.ps1 -GhArguments @('api', 'user', '--jq', '.login')
#   & ./scripts/Invoke-GitHub.ps1 -ScriptPath ./scripts/upload-release.ps1
[CmdletBinding(DefaultParameterSetName = 'GitHub')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'GitHub')]
    [ValidateNotNullOrEmpty()]
    [string[]] $GhArguments,

    [Parameter(Mandatory = $true, ParameterSetName = 'Script')]
    [ValidateNotNullOrEmpty()]
    [string] $ScriptPath,

    [Parameter(ParameterSetName = 'Script')]
    [string[]] $ScriptArguments = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
$portableGh = Join-Path $repoRoot 'tmp\tools\gh\bin\gh.exe'
$installedGh = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
$ghExecutable = if ($env:HALO_GH_PATH) { $env:HALO_GH_PATH } elseif ($ghCommand) { $ghCommand.Source } elseif (Test-Path -LiteralPath $portableGh) { $portableGh } else { $installedGh }
$savedEnvironment = @{}
foreach ($name in @('PATH', 'GH_TOKEN', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$exitCode = 1
$credentialOutput = $null
$passwordLine = $null

try {
    if (-not (Test-Path -LiteralPath $ghExecutable -PathType Leaf)) {
        throw 'GitHub CLI was not found. Install gh or set HALO_GH_PATH before releasing.'
    }
    $env:PATH = ([IO.Path]::GetDirectoryName($ghExecutable)) + [IO.Path]::PathSeparator + $env:PATH
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'

    if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN) -and [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
        # Capture all output. Only the password is retained in process memory.
        $credentialOutput = @(@('protocol=https', 'host=github.com', '') | & git credential fill 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'No noninteractive GitHub credential is available.' }
        $passwordLine = $credentialOutput | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($passwordLine) -or $passwordLine.Length -le 9) {
            throw 'No noninteractive GitHub credential is available.'
        }
        $env:GH_TOKEN = $passwordLine.Substring(9)
        $credentialOutput = $null
        $passwordLine = $null
    }

    if ($PSCmdlet.ParameterSetName -eq 'Script') {
        $resolvedScript = (Resolve-Path -LiteralPath $ScriptPath).ProviderPath
        if ([IO.Path]::GetExtension($resolvedScript) -ne '.ps1' -or -not (Test-Path -LiteralPath $resolvedScript -PathType Leaf)) {
            throw 'ScriptPath must point to an existing PowerShell script.'
        }
        # Separate process contains script exits and preserves its native exit code.
        # Arguments remain separate; no command text, interpolation, or Invoke-Expression.
        $powerShellExecutable = (Get-Process -Id $PID).Path
        & $powerShellExecutable -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $resolvedScript @ScriptArguments
    } else {
        & $ghExecutable @GhArguments
    }
    $exitCode = $LASTEXITCODE
} catch {
    # Do not print captured credential output or native credential-helper errors.
    [Console]::Error.WriteLine('GitHub launcher failed: ' + $_.Exception.Message)
    $exitCode = 1
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }
    $credentialOutput = $null
    $passwordLine = $null
}

exit $exitCode

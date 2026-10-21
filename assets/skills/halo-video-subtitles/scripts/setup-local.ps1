param([string]$FFmpeg, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:USERPROFILE '.pi/tools/video-subtitles-lite'
$configFile = Join-Path $runtime 'config.json'
$model = Join-Path $runtime 'ggml-base-q5_1.bin'
$cli = Join-Path $runtime 'whisper/Release/whisper-cli.exe'
if ($CheckOnly) {
    if (-not (Test-Path -LiteralPath $configFile) -or -not (Test-Path -LiteralPath $cli) -or -not (Test-Path -LiteralPath $model)) { throw 'Lightweight runtime is not ready.' }
    Write-Output $configFile
    return
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') { throw 'This installer is for Windows x64 CPU only.' }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
function Save-Verified([string]$Url,[string]$File,[string]$SHA256) {
    if (Test-Path -LiteralPath $File) {
        if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -eq $SHA256) { return }
        throw "Existing file hash differs; retained for inspection: $File"
    }
    $partial = "$File.download"
    Invoke-WebRequest -Uri $Url -OutFile $partial
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $SHA256) { throw "Download checksum mismatch: $partial" }
    Move-Item -LiteralPath $partial -Destination $File
}
if (-not (Test-Path -LiteralPath $cli)) {
    $zip = Join-Path $runtime 'whisper-cpu.zip'
    Save-Verified 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' $zip '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $destination = Join-Path $runtime 'whisper/Release'
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        foreach ($entry in $archive.Entries) {
            $name = [IO.Path]::GetFileName($entry.FullName)
            if ($name -eq 'whisper-cli.exe' -or $name -eq 'whisper.dll' -or $name -like 'ggml*.dll') {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $destination $name),$false)
            }
        }
    } finally { $archive.Dispose() }
    Remove-Item -LiteralPath $zip
}
Save-Verified 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin' $model '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'
if (-not $FFmpeg -and (Test-Path -LiteralPath $configFile)) { $FFmpeg = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).ffmpeg }
if (-not $FFmpeg) { $command = Get-Command ffmpeg -ErrorAction SilentlyContinue; if ($command) { $FFmpeg = $command.Source } }
if (-not $FFmpeg -or -not (Test-Path -LiteralPath $FFmpeg)) { throw 'ASR model is ready. Pass -FFmpeg with an existing FFmpeg executable; this installer does not install another copy.' }
@{ffmpeg=$FFmpeg;whisper=$cli;model=$model} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
Write-Output "LIGHTWEIGHT_RUNTIME=$runtime"

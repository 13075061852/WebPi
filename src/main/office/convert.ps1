param([string]$WorkDir,[ValidateSet('docx','xlsx','pptx')][string]$Kind)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$app = $null
$doc = $null
$exitCode = 0
try {
  $processName = @{docx='WINWORD';xlsx='EXCEL';pptx='POWERPNT'}[$Kind]
  if (Get-Process -Name $processName -ErrorAction SilentlyContinue) { throw 'Office is already running. Close it manually after saving your documents before converting.' }
  Write-Output 'HALO_STAGE=create application'
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HaloOfficeWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
  $progId = @{docx='Word.Application';xlsx='Excel.Application';pptx='PowerPoint.Application'}[$Kind]
  $createdAfter = Get-Date
  $app = New-Object -ComObject $progId
  [uint32]$officeProcessId = 0
  if ($Kind -eq 'docx') {
    $candidates = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $createdAfter })
    if ($candidates.Count -ne 1) { throw 'Cannot uniquely identify newly created Word process' }
    $officeProcessId = $candidates[0].Id
  } else {
    [void][HaloOfficeWindow]::GetWindowThreadProcessId([IntPtr]$app.HWND,[ref]$officeProcessId)
  }
  if (!$officeProcessId) { throw 'Cannot identify conversion process' }
  Write-Output "HALO_PID=$officeProcessId"
  $app.AutomationSecurity = 3
  $src = Join-Path $WorkDir ('source.' + $Kind)
  $dst = Join-Path $WorkDir 'result.pdf'
  Write-Output 'HALO_STAGE=open document'
  if ($Kind -eq 'docx') {
    $app.Visible = $false
    $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($src,$false,$true,$false)
    Write-Output 'HALO_STAGE=export PDF'
    $doc.SaveAs2([string]$dst,17)
  } elseif ($Kind -eq 'xlsx') {
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $app.AskToUpdateLinks = $false
    $doc = $app.Workbooks.Open($src,0,$true)
    Write-Output 'HALO_STAGE=export PDF'
    $doc.ExportAsFixedFormat(0,$dst)
  } else {
    $app.DisplayAlerts = 1
    $doc = $app.Presentations.Open($src,-1,0,0)
    Write-Output 'HALO_STAGE=export PDF'
    $doc.SaveAs($dst,32)
  }
  Write-Output 'HALO_STAGE=close document'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $exitCode = 1
} finally {
  if ($doc) { try { if ($Kind -eq 'pptx') { $doc.Close() } else { $doc.Close(0) } } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
  if ($doc) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
  if ($app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
}
exit $exitCode

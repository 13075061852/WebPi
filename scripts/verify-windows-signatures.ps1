param(
  [Parameter(Mandatory = $true)][string[]]$Paths,
  [Parameter(Mandatory = $true)][string]$ExpectedSubject
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) { throw 'Expected publisher subject is required' }
foreach ($file in $Paths) {
  $resolved = (Resolve-Path -LiteralPath $file).Path
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Not a file: $resolved" }
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne 'Valid') { throw "Signature verification failed ($($signature.Status)): $resolved" }
  if ($signature.SignerCertificate.Subject -cne $ExpectedSubject) { throw "Unexpected signer: $resolved" }
  if (-not $signature.TimeStamperCertificate) { throw "Trusted timestamp missing: $resolved" }
  [pscustomobject]@{
    Path = $resolved
    Status = [string]$signature.Status
    Publisher = $signature.SignerCertificate.Subject
    Thumbprint = $signature.SignerCertificate.Thumbprint
    TimestampAuthority = $signature.TimeStamperCertificate.Subject
  }
}

# Creates a netlify.zip from the netlify/ folder contents
# Run from the project root in PowerShell
param(
  [string] $out = 'netlify.zip'
)

$src = Join-Path -Path (Get-Location) -ChildPath 'netlify' -Resolve
if (-not (Test-Path $src)) {
  Write-Error "netlify folder not found: $src"
  exit 1
}

if (Test-Path $out) { Remove-Item $out -Force }

Compress-Archive -Path "$src\*" -DestinationPath $out -Force
Write-Output "Created $out"

# Builds the Windows capture helper (system audio per application through WASAPI process loopback).
# Needs the Visual C++ build tools; finds them itself when this is not a developer prompt.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'build\loopback'
New-Item -ItemType Directory -Force $out | Out-Null

if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw 'Visual C++ build tools not found (install "Desktop development with C++")' }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw 'Visual C++ build tools not found (install "Desktop development with C++")' }
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  cmd /c "`"$vcvars`" >nul && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } }
}

Push-Location $out
try {
  cl /nologo /EHsc /O2 /W3 (Join-Path $root 'native\windows\whisperbrain-loopback.cpp') ole32.lib mmdevapi.lib /Fe:whisperbrain-loopback.exe
  if ($LASTEXITCODE -ne 0) { throw 'cl failed' }
} finally { Pop-Location }
Write-Host "built build\loopback\whisperbrain-loopback.exe"

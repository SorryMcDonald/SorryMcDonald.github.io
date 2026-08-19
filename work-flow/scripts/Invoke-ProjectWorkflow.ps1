$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $scriptDir "_runtime/workflow_cli.py"
$primaryPython = if ($IsWindows) { "python" } else { "python3" }
$fallbackPython = if ($IsWindows) { "python3" } else { "python" }
$python = Get-Command $primaryPython -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command $fallbackPython -ErrorAction Stop }
& $python.Source $cli @args
exit $LASTEXITCODE

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $ScriptDir "_runtime/workflow_cli.py"
$PrimaryPython = if ($IsWindows) { "python" } else { "python3" }
$FallbackPython = if ($IsWindows) { "python3" } else { "python" }
$Python = Get-Command $PrimaryPython -ErrorAction SilentlyContinue
if (-not $Python) { $Python = Get-Command $FallbackPython -ErrorAction Stop }
& $Python.Source $Cli @args
exit $LASTEXITCODE

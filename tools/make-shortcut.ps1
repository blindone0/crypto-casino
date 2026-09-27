# Creates a single desktop shortcut pointing at START-CASINO.bat.
# Everything else stays inside the project folder.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'START-CASINO.bat'
if (-not (Test-Path $target)) { throw "missing $target" }

$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Crypto Casino.lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $target
$sc.WorkingDirectory = $root
$sc.Description = 'Start the crypto casino and open it in the browser'
$sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,131"
$sc.Save()

Write-Output "Shortcut created: $link"
Write-Output "Target: $target"

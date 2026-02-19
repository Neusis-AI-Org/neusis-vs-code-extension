$path = Join-Path $PSScriptRoot 'setup.ps1'
$content = Get-Content $path -Raw -Encoding UTF8
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message } } else { Write-Host 'Syntax OK' }

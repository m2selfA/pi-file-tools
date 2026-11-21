$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$script=Join-Path $root 'src/native/recycle.ps1'
$tokens=$null; $errors=$null
$null=[System.Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
Add-Type -Path (Join-Path $root 'src/native/Recycle.cs')
$reject=[PiFileTools.Sink]::new();$reject.RequireRecycle=$true
if ($reject.PreDeleteItem(0,$null) -ge 0 -or !$reject.RefusedPermanentDelete) { throw 'Permanent-delete callback guard failed' }
$accept=[PiFileTools.Sink]::new();$accept.RequireRecycle=$true
if ($accept.PreDeleteItem(128,$null) -ne 0 -or $accept.RefusedPermanentDelete) { throw 'Recycle callback guard failed' }
$purge=[PiFileTools.Sink]::new()
if ($purge.PreDeleteItem(0,$null) -ne 0) { throw 'Explicit purge callback failed' }
$collision=[PiFileTools.Sink]::new();$collision.Destination=$script
if ($collision.PreMoveItem(0,$null,$null,$null) -ge 0) { throw 'Native restore collision guard failed' }
[pscustomobject]@{powershellAst='passed'; csharpCompile='passed'; callbackChecks=4; runtimeFileMutations=0} | ConvertTo-Json -Compress

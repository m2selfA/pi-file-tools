$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-RecycledItems {
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.NameSpace(10)
  if ($null -eq $folder) { throw 'The current user Recycle Bin is unavailable.' }
  $result = New-Object System.Collections.Generic.List[object]
  foreach ($item in $folder.Items()) {
    $parent = [string]$item.ExtendedProperty('System.Recycle.DeletedFrom')
    $name = [string]$item.ExtendedProperty('System.FileName')
    if (!$name -or !$parent) { throw 'Recycle Bin item is missing its exact filename or original directory; refusing an incomplete enumeration.' }
    $date = $item.ExtendedProperty('System.Recycle.DateDeleted')
    $kind = if ($item.IsFolder) { 'directory' } else { 'file' }
    $result.Add([pscustomobject]@{ id=[string]$item.Path; originalPath=[IO.Path]::Combine($parent,$name); name=$name; deletedAt=if ($date) { ([datetime]$date).ToUniversalTime().ToString('o') } else { '' }; kind=$kind })
    if ($result.Count -gt 10000) { throw 'Recycle Bin exceeds the bounded enumeration limit (10000); no partial list returned.' }
  }
  return $result.ToArray()
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'list') {
    $response = @{ items=@(Get-RecycledItems) }
  } else {
    Add-Type -Path (Join-Path $PSScriptRoot 'Recycle.cs')
    switch ($request.action) {
      'linkKinds' {
        $paths=@($request.paths)
        if ($paths.Count -gt 128) { throw 'Link metadata query exceeds 128 entries.' }
        $items=@(foreach ($p in $paths) { if (!$p) { throw 'Missing link path.' }; @{path=[string]$p; kind=[PiFileTools.Native]::LinkKind([string]$p)} })
        $response=@{items=$items}
      }
      'moveNoReplace' { [PiFileTools.Native]::MoveNoReplace($request.source, $request.destination); $response=@{destination=$request.destination} }
      'put' {
        $before = @(Get-RecycledItems)
        $null = [PiFileTools.Native]::Operate('put', $request.path, $null)
        if ([PiFileTools.Sink]::Exists($request.path)) { throw 'Recycle operation did not remove the source path.' }
        $matches = @(Get-RecycledItems | Where-Object { $_.originalPath -ieq $request.path -and $_.id -notin $before.id })
        if ($matches.Count -ne 1) { throw 'Source moved but its exact Recycle Bin identity is uncertain. List the bin before retrying; no permanent-delete fallback was attempted.' }
        $response = @{ item=$matches[0] }
      }
      'restore' {
        $matches = @(Get-RecycledItems | Where-Object { $_.id -ceq $request.id })
        if ($matches.Count -ne 1) { throw 'Recycle Bin item not found or changed; list it again.' }
        $destination = if ($request.destination) { [string]$request.destination } else { $matches[0].originalPath }
        if ([PiFileTools.Sink]::Exists($destination)) { throw 'Restore destination already exists; choose a different destination.' }
        if (![IO.Directory]::Exists([IO.Path]::GetDirectoryName($destination))) { throw 'Restore parent is missing; create it with mkdir first.' }
        $actual = [PiFileTools.Native]::Operate('restore', $matches[0].id, $destination)
        if (!$actual) { $actual=$destination }
        if (![PiFileTools.Sink]::Exists($actual)) { throw 'Restore reported completion but the destination could not be verified.' }
        if (@(Get-RecycledItems | Where-Object { $_.id -ceq $request.id }).Count -ne 0) { throw 'Restore item still exists in Recycle Bin; inspect state before retrying.' }
        $response = @{id=$request.id; destination=$actual}
      }
      'purge' {
        $snapshot = @(Get-RecycledItems)
        $selected = @($request.ids)
        foreach ($id in $selected) { if (@($snapshot | Where-Object { $_.id -ceq $id }).Count -ne 1) { throw 'Selected Recycle Bin item not found; no items purged.' } }
        $removed=New-Object System.Collections.Generic.List[string]
        $failed=New-Object System.Collections.Generic.List[object]
        foreach ($id in $selected) {
          try {
            $null=[PiFileTools.Native]::Operate('purge', $id, $null)
            if (@(Get-RecycledItems | Where-Object { $_.id -ceq $id }).Count -ne 0) { throw 'Item remained in Recycle Bin after purge.' }
            $removed.Add($id)
          } catch { $failed.Add(@{id=$id; error=$_.Exception.Message}) }
        }
        $response = @{removed=@($removed.ToArray()); failed=@($failed.ToArray())}
      }
      default { throw 'Unknown native helper operation.' }
    }
  }
  [Console]::Out.Write(($response | ConvertTo-Json -Depth 12 -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}

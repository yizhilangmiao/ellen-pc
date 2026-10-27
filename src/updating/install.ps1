param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$transaction = Split-Path -Parent $JobFile
$root = [IO.Path]::GetFullPath([string]$job.root).TrimEnd('\')
$parent = Split-Path -Parent $root
if ($job.token -notmatch '^[a-f0-9-]{36}$' -or $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Invalid update target' }
$stage = Join-Path $parent ('.ellen-stage-' + $job.token)
$previous = Join-Path $parent ('.ellen-previous-' + $job.token)
$failed = Join-Path $parent ('.ellen-failed-' + $job.token)
$receipt = Join-Path $transaction 'result.json'
$journal = Join-Path $transaction 'journal.json'
$utf8 = New-Object Text.UTF8Encoding($false)
$movedOld = $false
$movedNew = $false
$newProcess = $null
$snapshots = @()
$restartAllowed = $false
function Long-Path([string]$file) {
 if ($file.StartsWith('\\?\')) { return $file }
 if ($file.StartsWith('\\')) { return '\\?\UNC\'+$file.Substring(2) }
 if ($file -notmatch '^[A-Za-z]:\\') { throw 'Expected absolute local update path' }
 return '\\?\'+$file
}
$script:lastPhase = ''
function Write-State([string]$phase, [string]$message, [long]$completed=0, [long]$total=0) {
 $state=@{phase=$phase;message=$message;root=$root;previous=$previous;stage=$stage;token=$job.token;completed=$completed;total=$total;time=[DateTime]::UtcNow.ToString('o')}
 $text=$state | ConvertTo-Json -Compress
 [IO.File]::WriteAllText($journal+'.tmp',$text,$utf8)
 for ($retry=0;$retry -lt 20;$retry++) {
  try { if ([IO.File]::Exists($journal)) { [IO.File]::Replace($journal+'.tmp',$journal,$journal+'.previous') } else { [IO.File]::Move($journal+'.tmp',$journal) };break }
  catch { if ($retry -eq 19) { throw };Start-Sleep -Milliseconds 20 }
 }
 if ($phase -ne $script:lastPhase) { [IO.File]::AppendAllText((Join-Path $transaction 'events.jsonl'),$text+[Environment]::NewLine,$utf8);$script:lastPhase=$phase }
}
function Get-SHA256([string]$file) {
 $stream=[IO.File]::OpenRead((Long-Path $file));$algorithm=[Security.Cryptography.SHA256]::Create()
 try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose();$algorithm.Dispose() }
}
function Move-DirectorySafe([string]$source,[string]$destination) {
 for ($attempt=0;$attempt -lt 60;$attempt++) { try { [IO.Directory]::Move((Long-Path $source),(Long-Path $destination));return } catch { if ($attempt -eq 59) { throw };Start-Sleep -Milliseconds 250 } }
}
function Safe-Child([string]$base, [string]$relative) {
 $invalidParts=@($relative.Split('/') | Where-Object {$_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$|^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)'})
 if ($relative -match '\\|[<>:"|?*\x00-\x1f]' -or $relative.StartsWith('/') -or $invalidParts.Count -gt 0) { throw 'Invalid update path' }
 $full=[IO.Path]::GetFullPath((Join-Path $base $relative.Replace('/','\')))
 if (!$full.StartsWith($base.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Update path escaped root' }
 return $full
}
function Assert-NoLinks([string]$base) {
 $base=Long-Path $base
 if (!(Test-Path -LiteralPath $base)) { return }
 if ((Get-Item -LiteralPath $base -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked directory is not supported' }
 foreach ($entry in Get-ChildItem -LiteralPath $base -Force) { if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked file is not supported' }; if ($entry.PSIsContainer) { Assert-NoLinks $entry.FullName } }
}
function Copy-Tree([string]$source,[string]$destination) {
 # A backup prefix can push otherwise valid Chromium cache paths past MAX_PATH.
 # Robocopy handles long paths without machine-wide registry changes. Keep all
 # customer files and empty directories; never use /MIR, /PURGE or /MOVE here.
 $copyTool=Join-Path $env:SystemRoot 'System32\robocopy.exe'
 if (!(Test-Path -LiteralPath $copyTool)) { throw '找不到系统资料备份工具，尚未安装更新。' }
 $copyLog=Join-Path $transaction 'data-copy.log'
 & $copyTool $source $destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /SL /NP /NFL /NDL ('/UNILOG+:'+$copyLog) | Out-Null
 $copyExit=$LASTEXITCODE
 if ($copyExit -ge 8) { throw ('资料备份或恢复未完成（错误码 '+$copyExit+'），请查看安装记录 data-copy.log。') }
}
function Launch-App {
 return Start-Process -FilePath (Join-Path $root '艾莲.exe') -ArgumentList @('--ellen-update-token='+$job.token) -WorkingDirectory $root -WindowStyle Hidden -PassThru
}
try {
 Write-State 'waiting' '正在等待软件保存并退出。'
 $owner=Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue
 if ($owner -and !$owner.WaitForExit(60000)) { throw '原程序未退出，未安装更新。' }
 foreach ($running in Get-Process) { try { $exePath=$running.Path } catch { continue }; if ($exePath -and $exePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '同一安装目录仍有程序运行，请退出剧情窗口后重试。' } }
 $restartAllowed = $true
 if (!(Test-Path -LiteralPath (Join-Path $root '艾莲.exe'))) { throw 'Original installation is missing' }
 Assert-NoLinks $root
 if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $previous) -or (Test-Path -LiteralPath $failed)) { throw 'Update transaction directory already exists' }
 # This helper only consumes the main process's already verified local plan.
 # Verify the plan hash again so a truncated job cannot become a partial install.
 $planPath=Join-Path $transaction 'plan.json'
 if ((Get-SHA256 $planPath) -ne $job.planSHA256) { throw 'Install plan changed' }
 $plan=Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
 Write-State 'backup' '正在备份已有资料。'
 $backupIndex=0
 foreach ($dataPath in $job.dataRoots) {
  $dataPath=[IO.Path]::GetFullPath([string]$dataPath)
  if ($dataPath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($dataPath+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Data and installation paths overlap' }
  $present=Test-Path -LiteralPath $dataPath
  $backup=Join-Path $transaction ('data-backup-'+$backupIndex)
  if ($present) { Assert-NoLinks $dataPath; Copy-Tree $dataPath $backup }
  $snapshots+=@{path=$dataPath;backup=$backup;present=$present};$backupIndex++
 }
 [IO.File]::WriteAllText((Join-Path $transaction 'snapshots.json'),($snapshots | ConvertTo-Json -Depth 5),$utf8)
 $completed=0;$total=$plan.files.Count;$lastProgress=[DateTime]::UtcNow
 Write-State 'staging' '正在安装更新…' 0 $total
 [void][IO.Directory]::CreateDirectory((Long-Path $stage))
 foreach ($file in $plan.files) {
  $destination=Safe-Child $stage $file.path
  [void][IO.Directory]::CreateDirectory((Long-Path (Split-Path -Parent $destination)))
  $source=if ($file.prepared) { [IO.Path]::GetFullPath([string]$file.prepared) } else { Safe-Child $root $file.path }
  if ($file.prepared -and !$source.StartsWith([string]$job.cacheRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Prepared file is outside update cache' }
  if ((Get-Item -LiteralPath (Long-Path $source)).Length -ne $file.bytes -or (Get-SHA256 $source) -ne $file.sha256) { throw '更新文件已变化，已停止安装。' }
  try { [void](New-Item -ItemType HardLink -Path (Long-Path $destination) -Target (Long-Path $source) -ErrorAction Stop) } catch { [IO.File]::Copy((Long-Path $source),(Long-Path $destination),$false) }
  $completed++
  if ($completed -eq $total -or ([DateTime]::UtcNow-$lastProgress).TotalMilliseconds -ge 200) { Write-State 'staging' '正在安装更新…' $completed $total;$lastProgress=[DateTime]::UtcNow }
 }
 Write-State 'switching' '正在切换版本。'
 Move-DirectorySafe $root $previous;$movedOld=$true
 Move-DirectorySafe $stage $root;$movedNew=$true
 Write-State 'starting' '安装已完成，正在打开新版艾莲…'
 $newProcess=Launch-App
 $healthy=Join-Path $transaction 'healthy.json'
 $deadline=[DateTime]::UtcNow.AddSeconds([int]$job.healthTimeout)
 $ok=$false
 while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Path -LiteralPath $healthy) { try { $health=Get-Content -LiteralPath $healthy -Raw -Encoding UTF8 | ConvertFrom-Json; if ($health.token -eq $job.token -and $health.version -eq $job.version) { $ok=$true;break } } catch {} }
  if ($newProcess.HasExited) { break }
  Start-Sleep -Milliseconds 300
 }
 if (!$ok) { throw '新版未完成启动验证，正在恢复旧版。' }
 Write-State 'complete' '更新完成。'
 [IO.File]::WriteAllText($receipt,(@{ok=$true;version=$job.version;previous=$previous;message='更新已完成，原版及资料备份已保留。'} | ConvertTo-Json),$utf8)
} catch {
 $message=$_.Exception.Message
 try {
  Write-State 'restoring' '更新未完成，正在恢复原版…'
  if ($newProcess -and !$newProcess.HasExited) { [void]$newProcess.CloseMainWindow(); if (!$newProcess.WaitForExit(5000)) { $newProcess.Kill(); $newProcess.WaitForExit() } }
  if ($movedNew) { Move-DirectorySafe $root $failed }
  if ($movedOld) { Move-DirectorySafe $previous $root }
  if ($movedNew) {
   foreach ($snapshot in $snapshots) {
    if (Test-Path -LiteralPath $snapshot.path) { Move-DirectorySafe $snapshot.path ($snapshot.path+'.failed-update-'+$job.token) }
    if ($snapshot.present) { Copy-Tree $snapshot.backup $snapshot.path }
   }
  }
  Write-State 'failed' $message
  [IO.File]::WriteAllText($receipt,(@{ok=$false;message=$message;recovered=$movedOld} | ConvertTo-Json),$utf8)
  # Never launch the old app alongside an instance that blocked the update.
  if ($restartAllowed -and (Test-Path -LiteralPath (Join-Path $root '艾莲.exe'))) { [void](Launch-App) }
 } catch {
  [IO.File]::WriteAllText($receipt,(@{ok=$false;message=$message;recoveryError=$_.Exception.Message;previous=$previous} | ConvertTo-Json),$utf8)
 }
 exit 1
}

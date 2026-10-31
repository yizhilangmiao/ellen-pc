param([int]$TimeoutMs = 1800)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($o) {
  $o | ConvertTo-Json -Compress -Depth 3
  exit 0
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
    })[0]
  if (-not $asTaskGeneric) { Emit @{ ok = $false; reason = "no-astask" } }

  function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait($TimeoutMs)) { return $null }
    return $task.Result
  }

  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
  if (-not $mgr) { Emit @{ ok = $false; reason = "no-manager" } }

  $s = $mgr.GetCurrentSession()
  if (-not $s) { Emit @{ ok = $true; playing = $false; reason = "no-session" } }

  $status = $s.GetPlaybackInfo().PlaybackStatus.ToString()
  $playing = ($status -eq "Playing")

  $title = ""; $artist = ""
  if ($playing) {
    try {
      $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
      $props = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      if ($props) {
        $title = [string]$props.Title
        $artist = [string]$props.Artist
      }
    } catch { }
  }

  $app = ""
  try { $app = [string]$s.SourceAppUserModelId } catch { }

  Emit @{ ok = $true; playing = $playing; status = $status; title = $title; artist = $artist; app = $app }
} catch {
  Emit @{ ok = $false; reason = $_.Exception.Message }
}

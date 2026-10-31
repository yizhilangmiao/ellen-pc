# 查询当前是否在放音乐，供小人模式「坐下听歌」使用
# 输出：{ok, playing, status, title, artist, app, source}
#
# 两级检测：
#   1) 系统媒体接口 SMTC —— Edge / Chrome / Spotify / Apple Music 这类守规矩的播放器走这里，能直接拿到歌名
#   2) 音频会话 Core Audio + 窗口标题 —— 网易云、QQ音乐等不向 SMTC 上报，只能看「它到底有没有在出声」，
#      歌名再从播放器窗口标题（网易云会写成「歌名 - 歌手」）里取
param([int]$TimeoutMs = 1800)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($o) {
  $o | ConvertTo-Json -Compress -Depth 3
  exit 0
}

# 这些播放器不上报 SMTC，只能用音频会话兜底（进程名小写）
# 认识的播放器（进程名小写）：命中就直接算在放音乐
$PLAYERS = @(
  # 国内
  "cloudmusic", "qqmusic", "kugou", "kwmusic", "kuwo", "kwplayer",
  "migumusic", "sodamusic", "bilibili", "lx-music-desktop", "yesplaymusic",
  "splayer", "musicfree", "saltplayer", "foobox",
  # 国外
  "spotify", "applemusic", "tidal", "deezer", "qobuz", "amazon music",
  "youtubemusic", "strawberry", "clementine", "rhythmbox",
  # 本地播放器 / 视频播放器（放视频时坐下听也说得过去）
  "foobar2000", "musicbee", "aimp", "aimp64", "winamp", "mediamonkey", "jriver",
  "vlc", "wmplayer", "mpc-hc", "mpc-hc64", "mpc-be", "mpc-be64", "mpv", "mpvnet",
  "potplayer", "potplayermini", "potplayermini64", "kmplayer", "gomplayer"
)
# 有声音但不是「在听歌」的东西：自己的语音、壁纸引擎、浏览器（走 SMTC）、通话软件
$BLOCK = @(
  "ellen", "wallpaper64", "wallpaper32", "audiodg",
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi",
  "360se", "360chrome", "qqbrowser", "sogouexplorer",
  "weixin", "wechat", "qq", "tim", "dingtalk", "feishu", "wemeet",
  "zoom", "teams", "ms-teams", "discord", "skype", "kook", "yy", "obs64", "obs32"
)
# 窗口标题里的这些不是歌名
$TITLE_SKIP = @("桌面歌词", "网易云音乐", "QQ音乐", "酷狗音乐", "酷我音乐", "Spotify", "Spotify Premium")

# ---------- 1) SMTC ----------
$smtc = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
    })[0]
  if ($asTaskGeneric) {
    function Await($op, $type) {
      $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
      if (-not $task.Wait($TimeoutMs)) { return $null }
      return $task.Result
    }
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $mgr = Await ($mgrType::RequestAsync()) $mgrType
    if ($mgr) {
      # 不只看当前会话：同屏有多个会话时挑出真正在播的那个
      $pick = $null
      foreach ($s in $mgr.GetSessions()) {
        if ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq "Playing") { $pick = $s; break }
      }
      if ($pick) {
        $title = ""; $artist = ""; $app = ""
        try { $app = [string]$pick.SourceAppUserModelId } catch { }
        try {
          $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
          $props = Await ($pick.TryGetMediaPropertiesAsync()) $propsType
          if ($props) { $title = [string]$props.Title; $artist = [string]$props.Artist }
        } catch { }
        $smtc = @{ ok = $true; playing = $true; status = "Playing"; title = $title; artist = $artist; app = $app; source = "smtc" }
      } else {
        $smtc = @{ ok = $true; playing = $false; status = "None"; title = ""; artist = ""; app = ""; source = "smtc" }
      }
    }
  }
} catch { }

if ($smtc -and $smtc.playing) { Emit $smtc }

# ---------- 2) Core Audio + 窗口标题 ----------
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AudioPeek {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out IntPtr key);
    int GetValue(IntPtr key, out IntPtr value);
    int SetValue(IntPtr key, IntPtr value);
    int Commit();
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl session);
  }

  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(ref Guid param, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr notify);
    int UnregisterAudioSessionNotification(IntPtr notify);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(ref Guid param, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr notify);
    int UnregisterAudioSessionNotification(IntPtr notify);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionManager2 {
    int GetAudioSessionControl(ref Guid sessionGuid, int streamFlags, out IAudioSessionControl session);
    int GetSimpleAudioVolume(ref Guid sessionGuid, int streamFlags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    int RegisterSessionNotification(IntPtr notify);
    int UnregisterSessionNotification(IntPtr notify);
    int RegisterDuckNotification(string sessionId, IntPtr notify);
    int UnregisterDuckNotification(IntPtr notify);
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
    int GetMeteringChannelCount(out int count);
    int GetChannelsPeakValues(int count, [Out] float[] peaks);
    int QueryHardwareSupport(out int mask);
  }

  public sealed class SessionInfo {
    public uint Pid;
    public int State;
    public float Peak;
  }

  public static SessionInfo[] List() {
    var list = new List<SessionInfo>();
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) != 0) return list.ToArray();

    var iidMgr = typeof(IAudioSessionManager2).GUID;
    object raw;
    if (device.Activate(ref iidMgr, 23, IntPtr.Zero, out raw) != 0) return list.ToArray();
    var mgr = (IAudioSessionManager2)raw;

    IAudioSessionEnumerator sessions;
    if (mgr.GetSessionEnumerator(out sessions) != 0) return list.ToArray();
    int n;
    sessions.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IAudioSessionControl ctl;
      if (sessions.GetSession(i, out ctl) != 0) continue;
      var ctl2 = ctl as IAudioSessionControl2;
      if (ctl2 == null) continue;
      var info = new SessionInfo();
      int st;
      ctl2.GetState(out st);
      info.State = st;
      uint pid;
      ctl2.GetProcessId(out pid);
      info.Pid = pid;
      var meter = ctl as IAudioMeterInformation;
      if (meter != null) {
        float peak;
        if (meter.GetPeakValue(out peak) == 0) info.Peak = peak;
      }
      list.Add(info);
    }
    return list.ToArray();
  }
}

public sealed class WinTitle {
  public uint Pid;
  public string Title;
  public bool Visible;
  public bool Minimized;
}

public static class WinScan {
  private delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static WinTitle[] Titles() {
    var list = new List<WinTitle>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      var t = new WinTitle();
      t.Title = sb.ToString();
      t.Visible = IsWindowVisible(h);
      t.Minimized = IsIconic(h);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      t.Pid = pid;
      list.Add(t);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@

# 编译一次就缓存成 dll，之后每 12 秒轮询时直接加载（约 0.2s 而不是 1.5s）
$cacheDir = Join-Path $env:TEMP "ellen-audio"
$dll = Join-Path $cacheDir "audio-peek-1.1.dll"
$loaded = $false
$errs = @()
if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
if (Test-Path $dll) {
  try { Add-Type -Path $dll -ErrorAction Stop; $loaded = $true } catch { $loaded = $false; $errs += "path:" + $_.Exception.Message }
}
if (-not $loaded) {
  try {
    Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $dll -ErrorAction Stop | Out-Null
    $loaded = $true
  } catch {
    $errs += "asm:" + $_.Exception.Message
    try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null; $loaded = $true } catch { $errs += "td:" + $_.Exception.Message }
  }
}
if (-not ("AudioPeek" -as [type])) {
  # -OutputAssembly 只产出 dll、不把类型带进会话，那就显式加载一次
  try { Add-Type -Path $dll -ErrorAction Stop; $loaded = $true } catch { $errs += "reload:" + $_.Exception.Message }
}
if (-not $loaded) { Emit @{ ok = $false; playing = $false; reason = ("no-coreaudio " + ($errs -join " | ")) } }
if (-not ("AudioPeek" -as [type])) { Emit @{ ok = $false; playing = $false; reason = ("type-missing " + ($errs -join " | ")) } }

try {
  $sessions = [AudioPeek]::List()
} catch {
  Emit @{ ok = $false; playing = $false; reason = "audio-fail:" + $_.Exception.Message }
}

# 认识的播放器优先；不认识的先记下来，等看完窗口标题再决定
$hit = $null
$unknown = $null
foreach ($s in $sessions) {
  if ($s.State -ne 1) { continue }        # 1 = Active
  if ($s.Peak -lt 0.0008) { continue }    # 有输出才算是真的在放
  $name = ""
  try { $name = (Get-Process -Id $s.Pid -ErrorAction Stop).ProcessName.ToLower() } catch { continue }
  if ($BLOCK -contains $name) { continue }
  if ($PLAYERS -contains $name) { $hit = @{ pid = $s.Pid; name = $name; peak = $s.Peak }; break }
  if (-not $unknown) { $unknown = @{ pid = $s.Pid; name = $name; peak = $s.Peak } }
}

$cand = if ($hit) { $hit } else { $unknown }
if (-not $cand) {
  if ($smtc) { Emit $smtc }
  Emit @{ ok = $true; playing = $false; status = "None"; title = ""; artist = ""; app = ""; source = "audio" }
}

# 从播放器窗口标题里取歌名：网易云会写成「歌名 - 歌手」
$title = ""; $artist = ""
try {
  $pids = @()
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    if ($p.ProcessName.ToLower() -eq $cand.name) { $pids += $p.Id }
  }
  $best = ""; $bestScore = -1
  foreach ($w in [WinScan]::Titles()) {
    if ($pids -notcontains [int]$w.Pid) { continue }
    $t = [string]$w.Title
    if (-not $t) { continue }
    $t = $t.Trim()
    if ($TITLE_SKIP -contains $t) { continue }
    # GDI+ / IME / 歌词 / 设置 这些辅助窗口的标题不是歌名
    if ($t -match "GDI\+|Default IME|MSCTFIME|歌词|音量|设置|登录|更新|下载|Tooltip") { continue }
    if ($t.Length -gt 80) { continue }
    $score = 0
    if ($t -match "\s+-\s+") { $score += 100 }              # 「歌名 - 歌手」这种最像
    if ($w.Visible -and -not $w.Minimized) { $score += 40 }  # 可见主窗口优先
    elseif ($w.Visible) { $score += 20 }
    $score -= [math]::Min($t.Length, 60) * 0.1
    if ($score -gt $bestScore) { $bestScore = $score; $best = $t }
  }
  if ($best) {
    $parts = $best -split "\s+-\s+"
    if ($parts.Count -ge 2) {
      $artist = $parts[$parts.Count - 1].Trim()
      $title = (($parts[0..($parts.Count - 2)]) -join " - ").Trim()
    } else {
      $title = $best.Trim()
    }
  }
} catch { }

# 不认识的进程：只有窗口标题长得像「歌名 - 歌手」才认，免得把游戏、提示音当成听歌
if (-not $hit) {
  $looksSong = $title -and $artist -and $artist.Length -le 24 -and $title.Length -le 42
  if (-not $looksSong) {
    if ($smtc) { Emit $smtc }
    Emit @{ ok = $true; playing = $false; status = "None"; title = ""; artist = ""; app = ""; source = "audio" }
  }
}

Emit @{
  ok = $true; playing = $true; status = "Playing"
  title = $title; artist = $artist; app = $cand.name; peak = [math]::Round($cand.peak, 3); source = "audio"
}

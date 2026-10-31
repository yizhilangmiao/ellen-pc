# 列出屏幕上可见的顶层窗口（标题 + 屏幕坐标），供小人模式「好奇观察」使用
# 输出：JSON 数组 [{"title":"...","x":0,"y":0,"w":1200,"h":800}]
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Enum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$list = New-Object System.Collections.ArrayList
$cb = [Win32Enum+EnumProc]{
  param($h, $l)
  if (-not [Win32Enum]::IsWindowVisible($h)) { return $true }
  if ([Win32Enum]::IsIconic($h)) { return $true }
  $cloaked = 0
  if ([Win32Enum]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) { return $true }
  $len = [Win32Enum]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][Win32Enum]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  $r = New-Object Win32Enum+RECT
  if (-not [Win32Enum]::GetWindowRect($h, [ref]$r)) { return $true }
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -lt 360 -or $hh -lt 260) { return $true }
  $null = $list.Add([pscustomobject]@{ title = $title; x = $r.Left; y = $r.Top; w = $w; h = $hh })
  return $true
}
[void][Win32Enum]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -InputObject @($list) -Compress -Depth 3

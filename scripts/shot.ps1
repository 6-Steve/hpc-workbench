# Capture one window (by process name) to PNG, cropped to its exact rectangle.
#
# Why the virtual screen: on a multi-monitor setup the window can sit at x > primary
# width (e.g. 2801 on a 2560-wide primary). CopyFromScreen with the window's own
# coordinates then grabs the wrong pixels. Capturing the whole virtual desktop first
# and cropping afterwards works with negative origins and any monitor layout.
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI, Chinese comments garble.

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ProcessName = 'HPC Workbench',
  [string]$DebugFull = '',
  [double]$Scale = 0
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

[WinCap]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proc) {
  Write-Error "process not found: $ProcessName"
  exit 2
}

$handle = $proc.MainWindowHandle

[WinCap]::ShowWindow($handle, 9) | Out-Null
[WinCap]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null

$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

$left = [Math]::Max($rect.Left, $virtual.Left)
$top = [Math]::Max($rect.Top, $virtual.Top)
$right = [Math]::Min($rect.Right, $virtual.Right)
$bottom = [Math]::Min($rect.Bottom, $virtual.Bottom)

$width = $right - $left
$height = $bottom - $top

if ($width -le 0 -or $height -le 0) {
  Write-Error "bad window rect after clamping: $width x $height"
  exit 3
}

# Preferred path: ask the window to render itself (PW_RENDERFULLCONTENT = 2).
# This ignores the desktop entirely, so wallpaper / other windows / multi-monitor
# geometry cannot leak in.
# Scale <= 0 means auto: window rect is in physical pixels, but the content may be
# rendered at a different DPI factor. GetDpiForWindow is the reliable source.
if ($Scale -le 0) {
  $dpi = [WinCap]::GetDpiForWindow($handle)
  if ($dpi -le 0) { $dpi = 96 }
  $Scale = $dpi / 96.0
}

$bw = [int]($width * $Scale); $bh = [int]($height * $Scale)
$bitmap = New-Object System.Drawing.Bitmap $bw, $bh
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = [WinCap]::PrintWindow($handle, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if ($ok) {
  $sample = $bitmap.GetPixel([int]($bw / 2), [int]($bh / 2))
  $black = ($sample.R -eq 0 -and $sample.G -eq 0 -and $sample.B -eq 0)
  if (-not $black) {
    $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    "mode=printwindow|virtual=$($virtual.Left),$($virtual.Top) $($virtual.Width)x$($virtual.Height)|window=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)|scale=$Scale|saved=$bw x $bh|center=$($sample.R),$($sample.G),$($sample.B)" |
      Set-Content -Path "$Out.txt" -Encoding UTF8
    Write-Output "$Out|$width|$height|printwindow"
    exit 0
  }
}
$bitmap.Dispose()

# Fallback: screen grab of the virtual desktop, cropped to the window rect.
$full = New-Object System.Drawing.Bitmap $virtual.Width, $virtual.Height
$gFull = [System.Drawing.Graphics]::FromImage($full)
$gFull.CopyFromScreen($virtual.Left, $virtual.Top, 0, 0, (New-Object System.Drawing.Size $virtual.Width, $virtual.Height))

$cropRect = New-Object System.Drawing.Rectangle ($left - $virtual.Left), ($top - $virtual.Top), $width, $height
$cropped = $full.Clone($cropRect, $full.PixelFormat)
if ($DebugFull) {
  $full.Save($DebugFull, [System.Drawing.Imaging.ImageFormat]::Png)
}

$cropped.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

$gFull.Dispose()
$full.Dispose()
$cropped.Dispose()

$screens = ([System.Windows.Forms.Screen]::AllScreens |
  ForEach-Object { "$($_.Bounds.Left),$($_.Bounds.Top) $($_.Bounds.Width)x$($_.Bounds.Height)" }) -join ' ; '

"mode=crop|virtual=$($virtual.Left),$($virtual.Top) $($virtual.Width)x$($virtual.Height)|window=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)|cropped=$width x $height|screens=$screens" |
  Set-Content -Path "$Out.txt" -Encoding UTF8

Write-Output "$Out|$width|$height"

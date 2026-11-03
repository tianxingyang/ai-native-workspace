# Test installation only; no production process lookup or generic window bridge.
param([ValidateSet('close','restore')][string]$Action = 'close')
$ErrorActionPreference = 'Stop'
$exe = Join-Path (Get-Location) '.desktop\installed\coseat-desktop.exe'
$app = @(Get-Process coseat-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
if ($app.Count -ne 1) { throw 'Expected exactly one CoSeat test instance' }
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CoSeatTestWindow {
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
if ($Action -eq 'close') {
  if (![CoSeatTestWindow]::PostMessage($app[0].MainWindowHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Close message failed' }
} else { Start-Process -FilePath $exe }

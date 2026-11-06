# Test-only helper for this exact installed candidate. Never use MainWindowHandle:
# once the UI is hidden, .NET may return the zero-sized single-instance event window.
param([ValidateSet('close','restore')][string]$Action = 'close')
$ErrorActionPreference = 'Stop'
$exe = Join-Path (Get-Location) '.desktop\installed\coseat-desktop.exe'
$app = @(Get-Process coseat-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
if ($app.Count -ne 1) { throw 'Expected exactly one CoSeat test instance' }
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class CoSeatInstalledMainWindow {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 public static IntPtr[] Find(uint target){var found=new List<IntPtr>();EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==target){var c=new StringBuilder(128);GetClassName(h,c,128);if(c.ToString()=="Tauri Window")found.Add(h);}return true;},IntPtr.Zero);return found.ToArray();}
}
'@
$windows=[CoSeatInstalledMainWindow]::Find($app[0].Id)
if($windows.Count -ne 1){throw 'Expected one actual Tauri UI window'}
if ($Action -eq 'close') {
  if([CoSeatInstalledMainWindow]::IsWindowVisible($windows[0])) {
    if(-not [CoSeatInstalledMainWindow]::PostMessage($windows[0],0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Close message failed'}
  }
} else {Start-Process -FilePath $exe -WindowStyle Hidden}

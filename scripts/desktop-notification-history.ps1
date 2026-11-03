# Test helper: read only this application's own notification records. No settings
# changes and no notification contents from other applications.
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$manager = [Windows.UI.Notifications.ToastNotificationManager]
$items = @($manager::History.GetHistory('tech.anewell.coseat.demo'))
$records = @($items | ForEach-Object {
  [xml]$xml = $_.Content.GetXml()
  if ($xml.toast.launch -match '^coseat-demo-notice://notification/[0-9a-f]{32}$') {
    [pscustomobject]@{ uri = [string]$xml.toast.launch; activation = [string]$xml.toast.activationType }
  }
})
ConvertTo-Json -InputObject $records -Compress

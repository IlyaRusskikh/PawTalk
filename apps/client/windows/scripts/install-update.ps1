param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][int]$ParentId,
  [Parameter(Mandatory)][string]$InstallDirectory,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$StatusFile,
  [Parameter(Mandatory)][string]$ReadyFile,
  [Parameter(Mandatory)][string]$Token,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$LabelsFile,
  [switch]$NoUi,
  [int]$StartupTimeout = 45
)
$ErrorActionPreference = 'Stop'
$log = Join-Path (Split-Path -Parent $StatusFile) 'update-helper.log'
$form = $null
$setup = $null
function Write-State([string]$Phase) {
  $value = @{ token=$Token; version=$Version; executable=$Executable; phase=$Phase; time=[DateTime]::UtcNow.ToString('o') }
  [IO.File]::WriteAllText($StatusFile, ($value | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  Add-Content -LiteralPath $log -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Phase)
}
function Read-State {
  try { return ([IO.File]::ReadAllText($StatusFile, [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $null }
}
function Show-Phase([string]$Text, [int]$Seconds = 0) {
  if ($form) {
    $heading.Text = $Text
    $detail.Text = "$($labels.elapsed): $Seconds $($labels.seconds)`n$($labels.hint)"
    [Windows.Forms.Application]::DoEvents()
  }
}
try {
  $labels = [IO.File]::ReadAllText($LabelsFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if (-not $NoUi) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = $labels.title
    $form.ClientSize = New-Object Drawing.Size(480, 190)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.ControlBox = $false
    $form.ShowInTaskbar = $true
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)
    $heading = New-Object Windows.Forms.Label
    $heading.Location = New-Object Drawing.Point(24, 24)
    $heading.Size = New-Object Drawing.Size(432, 44)
    $progress = New-Object Windows.Forms.ProgressBar
    $progress.Location = New-Object Drawing.Point(24, 82)
    $progress.Size = New-Object Drawing.Size(432, 20)
    $progress.Style = 'Marquee'
    $detail = New-Object Windows.Forms.Label
    $detail.Location = New-Object Drawing.Point(24, 120)
    $detail.Size = New-Object Drawing.Size(432, 48)
    $form.Controls.AddRange(@($heading, $progress, $detail))
    $form.Show()
    Show-Phase $labels.waiting
  }
  # Keep the app open until this helper is initialized and its status is visible.
  Write-State 'waiting'
  [IO.File]::WriteAllText($ReadyFile, $Token, [Text.Encoding]::UTF8)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (Get-Process -Id $ParentId -ErrorAction SilentlyContinue) {
    Show-Phase $labels.waiting ([int]$clock.Elapsed.TotalSeconds)
    if ($clock.Elapsed.TotalSeconds -gt 120) { throw 'The app did not finish shutting down.' }
    Start-Sleep -Milliseconds 200
  }
  Write-State 'installing'
  Show-Phase $labels.installing
  # NSIS runs the old uninstaller, replaces files and launches the new app.
  # /D must be the final argument without quotes, per NSIS command-line rules.
  $setup = Start-Process -FilePath $Installer -ArgumentList "/S --updated --force-run /D=$InstallDirectory" -WindowStyle Hidden -PassThru
  $clock.Restart()
  # Wait for the installer alone, rather than its entire descendant process tree.
  while (-not $setup.WaitForExit(200)) {
    Show-Phase $labels.installing ([int]$clock.Elapsed.TotalSeconds)
  }
  if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)" }
  $state = Read-State
  if (-not ($state.token -eq $Token -and $state.phase -eq 'launched')) { Write-State 'starting' }
  Show-Phase $labels.starting
  $clock.Restart()
  $fallbackStarted = $false
  $launched = $false
  while ($clock.Elapsed.TotalSeconds -lt $StartupTimeout) {
    $state = Read-State
    if ($state.token -eq $Token -and $state.version -eq $Version -and $state.phase -eq 'launched') { $launched = $true; break }
    if (-not $fallbackStarted -and $clock.Elapsed.TotalSeconds -ge 10) {
      Start-Process -FilePath $Executable -ArgumentList '--updated' -WorkingDirectory $InstallDirectory | Out-Null
      $fallbackStarted = $true
    }
    Show-Phase $labels.starting ([int]$clock.Elapsed.TotalSeconds)
    Start-Sleep -Milliseconds 200
  }
  if (-not $launched) { throw 'The new version did not confirm startup. Use the application shortcut or the saved installer.' }
  Write-State 'complete'
  Show-Phase $labels.done
  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue
  if ($form) { Start-Sleep -Milliseconds 500; $form.Close() }
} catch {
  $failure = $_.Exception.Message
  try { Write-State 'failed'; Add-Content -LiteralPath $log -Value $failure } catch {}
  if ($form) {
    $form.ClientSize = New-Object Drawing.Size(540, 240)
    $heading.Text = $labels.failure
    $heading.Size = New-Object Drawing.Size(492, 44)
    $progress.Style = 'Blocks'
    $detail.Size = New-Object Drawing.Size(492, 96)
    $detail.Text = "$($labels.details)`n$log"
    $form.ControlBox = $true
    while ($form.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
  } else { Write-Error $failure -ErrorAction Continue }
  exit 1
} finally { if ($form) { $form.Dispose() }; if ($setup) { $setup.Dispose() } }

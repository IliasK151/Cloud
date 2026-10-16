# Meridian trading floor: one-step setup for Windows 10 and 11.
#
# Open PowerShell (Start menu, type PowerShell, press Enter) and paste this line:
#
#   irm https://raw.githubusercontent.com/IliasK151/Cloud/HEAD/setup-windows.ps1 | iex
#
# It installs Node.js and Git if they're missing (with winget, Windows' own installer),
# downloads the floor into your user folder (C:\Users\<you>\trading-floor), or updates it if
# it's already there, installs its packages, brings over the data you exported on your Mac
# (if it finds the file), puts "Trading Floor" on your desktop and in the Start menu, and can
# run the floor non-stop in the background. Run it again any time: it only does what's missing.
# Nothing here needs administrator rights (Windows asks once while installing Node.js or Git).

function Install-TradingFloor {
  $Repo = 'https://github.com/IliasK151/Cloud.git'
  $Dest = Join-Path $env:USERPROFILE 'trading-floor'

  function Say([string]$t = '') { Write-Host "  $t" }
  function Step([string]$t) { Write-Host ''; Write-Host "  == $t" -ForegroundColor Cyan }
  function Ok([string]$t) { Write-Host "  OK  $t" -ForegroundColor Green }
  function Warn([string]$t) { Write-Host "  !   $t" -ForegroundColor Yellow }
  function Has([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function Ask([string]$q, [string]$default = 'Y') {
    $hint = 'y/N'
    if ($default -eq 'Y') { $hint = 'Y/n' }
    $a = Read-Host "  $q [$hint]"
    if ([string]::IsNullOrWhiteSpace($a)) { $a = $default }
    return ($a -match '^[Yy]')
  }
  function Install-App([string]$id, [string]$name, [string]$page) {
    if (-not (Has 'winget')) {
      Warn "$name isn't installed, and winget (Windows' installer) isn't on this PC."
      Say "Your browser opens the download page: install $name, then run this setup again."
      Start-Process $page
      throw "$name is needed"
    }
    Say "Installing $name (Windows may ask for permission)..."
    winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
  function Node-Major {
    if (-not (Has 'node')) { return 0 }
    $v = (& node -v) 2>$null
    if ($v -match '^v(\d+)') { return [int]$Matches[1] }
    return 0
  }

  Write-Host ''
  Write-Host '  Meridian trading floor - setup for Windows' -ForegroundColor White
  Write-Host '  -------------------------------------------'
  if ($env:OS -ne 'Windows_NT') { throw 'This setup is for Windows. On a Mac, see the README.' }

  # 1. PowerShell may run npm (npm.ps1): Windows blocks scripts until this is set once per user.
  try {
    $pol = Get-ExecutionPolicy -Scope CurrentUser
    if ($pol -eq 'Undefined' -or $pol -eq 'Restricted') {
      Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
      Ok 'PowerShell may now run npm commands (execution policy RemoteSigned, for your user only).'
    }
  } catch { Warn "Couldn't change PowerShell's execution policy ($($_.Exception.Message)). Use Command Prompt for npm commands." }

  # 2. Node.js and Git.
  Step 'Node.js and Git'
  if ((Node-Major) -lt 18) { Install-App 'OpenJS.NodeJS.LTS' 'Node.js' 'https://nodejs.org/en/download' }
  if ((Node-Major) -lt 18) {
    if (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $env:Path = "$env:ProgramFiles\nodejs;$env:Path" }
  }
  if ((Node-Major) -lt 18) { throw 'Node.js 18 or newer is needed. Install the LTS from https://nodejs.org, close this window, open a new PowerShell and run the setup again.' }
  Ok "Node.js $(& node -v)"
  if (-not (Has 'git')) { Install-App 'Git.Git' 'Git' 'https://git-scm.com/download/win' }
  if (-not (Has 'git')) {
    if (Test-Path "$env:ProgramFiles\Git\cmd\git.exe") { $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path" }
  }
  if (-not (Has 'git')) { throw 'Git is needed. Install it from https://git-scm.com/download/win, close this window, open a new PowerShell and run the setup again.' }
  Ok "$(& git --version)"

  # 3. The floor itself.
  Step "The floor ($Dest)"
  if (Test-Path (Join-Path $Dest '.git')) {
    Say 'Already here: getting the newest version...'
    & git -C $Dest pull --ff-only
    if ($LASTEXITCODE -ne 0) { Warn 'The update did not download (see above). Carrying on with the version you have.' }
  } elseif ((Test-Path $Dest) -and (Get-ChildItem -Force $Dest | Select-Object -First 1)) {
    throw "$Dest already exists but isn't a git copy of the floor. Rename that folder (e.g. trading-floor-old), then run this again."
  } else {
    & git clone $Repo $Dest
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the floor (see above). Check your internet connection and run this again.' }
  }
  Ok 'Floor downloaded.'

  Push-Location $Dest
  try {
    # 4. Its packages.
    Step 'Packages'
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed (see above). Check your internet connection and run this again.' }
    Ok 'Packages installed.'

    # 5. Data from the Mac (npm run move -- export there).
    Step 'Your data from the Mac'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $places = @((Join-Path $env:USERPROFILE 'Downloads'), $desktop, $Dest, $env:USERPROFILE) | Where-Object { $_ -and (Test-Path $_) }
    $file = Get-ChildItem -Path $places -Filter 'trading-floor-data-*.tgz' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $hasData = Test-Path (Join-Path $Dest 'data\live.json')
    if ($file) {
      $q = "Bring over $($file.Name) (price history, FTMO setup, track record, settings)?"
      $default = 'Y'
      if ($hasData) { $q = "This floor already has data. Replace it with $($file.Name)? (the current data is kept aside)"; $default = 'N' }
      if (Ask $q $default) {
        & node.exe scripts\move.js import $file.FullName
        if ($LASTEXITCODE -ne 0) { Warn 'The import did not finish (see above). You can run it later: npm run move -- import' }
      }
    } elseif (-not $hasData) {
      Say 'No data file from the Mac found (that is fine for a fresh start). To bring your Mac floor over:'
      Say '  on the Mac, in the floor folder: git pull, then npm run service -- uninstall, then npm run move -- export'
      Say '  copy the file it makes into Downloads on this PC, and run this setup again.'
    } else { Ok 'This floor already has its data.' }

    # 6. Shortcuts: desktop and Start menu.
    Step 'Shortcuts'
    $shell = New-Object -ComObject WScript.Shell
    $icon = (Get-Command node).Source + ',0'
    function Link([string]$at, [string]$target, [string]$desc) {
      $s = $shell.CreateShortcut($at)
      $s.TargetPath = $target
      $s.WorkingDirectory = $Dest
      $s.Description = $desc
      $s.IconLocation = $icon
      $s.Save()
    }
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Trading Floor'
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    Link (Join-Path $desktop 'Trading Floor.lnk') (Join-Path $Dest 'start.bat') 'Open the trading floor'
    Link (Join-Path $menu 'Trading Floor.lnk') (Join-Path $Dest 'start.bat') 'Open the trading floor'
    Link (Join-Path $menu 'Trading Floor (demo).lnk') (Join-Path $Dest 'start-demo.bat') 'The trading floor on simulated prices'
    Link (Join-Path $menu 'Update Trading Floor.lnk') (Join-Path $Dest 'update.bat') 'Get the newest version and restart the floor'
    Link (Join-Path $menu 'Trading Floor doctor.lnk') (Join-Path $Dest 'doctor.bat') 'Check every connection and say what to fix'
    $folder = $shell.CreateShortcut((Join-Path $menu 'Trading Floor folder.lnk'))
    $folder.TargetPath = $Dest
    $folder.Save()
    Ok '"Trading Floor" is on your desktop; the Start menu has it too, with Update, Doctor and demo.'

    # 7. Run it.
    Step 'Run it'
    $go = $true
    if (Test-Path (Join-Path $Dest 'data\live.json')) {
      Say 'Two floors must never trade the same FTMO account at once.'
      $go = Ask 'Is the floor on your Mac switched off for good (npm run service -- uninstall there)?' 'N'
      if (-not $go) { Say 'Then switch it off there first, and start this one with "Trading Floor" on your desktop.' }
    }
    if ($go) {
      if (Ask 'Run the floor non-stop in the background (starts at every login, keeps the PC awake; recommended)?' 'Y') {
        & node.exe scripts\service.js install
        Start-Process 'http://localhost:3000'
      } elseif (Ask 'Start the floor now, in its own window?' 'Y') {
        Start-Process -FilePath (Join-Path $Dest 'start.bat') -WorkingDirectory $Dest
      }
    }
  } finally { Pop-Location }

  Write-Host ''
  Write-Host '  Done. Next, MetaTrader 5 (about 5 minutes, once):' -ForegroundColor White
  Say '  1. Install FTMO''s MetaTrader 5 for Windows (FTMO Client Area) and log in to your account.'
  Say '  2. MT5: Tools > Options > Expert Advisors: tick "Allow algorithmic trading" and'
  Say '     "Allow WebRequest for listed URL", and add http://127.0.0.1:3000'
  Say '  3. MT5: Tools > Options > Charts: "Max bars in chart" = 100000 (months of history for the desks).'
  Say '  4. The floor, FTMO tab: "Put the EA into MT5", then in MT5 Navigator right-click'
  Say '     Expert Advisors > Refresh, right-click MeridianBridge > Modify, and press Compile.'
  Say '  5. Drag MeridianBridge onto a chart, paste the bridge token from the FTMO tab into its Inputs,'
  Say '     tick "Allow Algo Trading", and switch on Algo Trading in the MT5 toolbar.'
  Say '  Also: Settings > System > Power: when plugged in, sleep after "Never".'
  Say "  The floor lives in $Dest. Update it any time with 'Update Trading Floor' in the Start menu."
  Write-Host ''
}

try { Install-TradingFloor } catch { Write-Host ''; Write-Host "  The setup stopped: $($_.Exception.Message)" -ForegroundColor Red; Write-Host '' }

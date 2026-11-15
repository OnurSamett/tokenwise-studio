# Windows beta: irm https://tokenwise.site/install.ps1 | iex
& {
    $ErrorActionPreference = 'Stop'
    function Step([string]$Message) { Write-Host "`n[tokenwise studio] $Message" }
    function Fail([string]$Message) { throw "[tokenwise studio] $Message" }
    Step '1/4 Checking Windows'
    if ($env:OS -ne 'Windows_NT') { Fail 'This installer needs Windows. On macOS: curl -fsSL https://tokenwise.site/install.sh | sh' }
    Step '2/4 Checking Node.js 20+, npm and git'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Install Node.js 20+ from https://nodejs.org, reopen PowerShell, and retry.' }
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 20) { Fail 'Node.js 20+ is required. Upgrade from https://nodejs.org, reopen PowerShell, and retry.' }
    # Explicit .cmd avoids npm.ps1 execution-policy failures. Never change execution policy.
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm is missing. Reinstall Node.js from https://nodejs.org.' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Install Git from https://git-scm.com/download/win, reopen PowerShell, and retry.' }
    & git --version
    if ($LASTEXITCODE -ne 0) { Fail 'git is installed but could not run. Repair Git and retry.' }
    Step '3/4 Finding the latest verified GitHub release'
    Set-Location -Path $HOME
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/OnurSamett/tokenwise-studio/releases/latest' -Headers @{ 'User-Agent' = 'tokenwise-studio-installer'; 'Accept' = 'application/vnd.github+json' }
    $tag = [string]$rel.tag_name
    $hasSums = @($rel.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }).Count -gt 0
    if ($rel.draft -or $rel.prerelease -or $tag -notmatch '^v\d+\.\d+\.\d+$' -or -not $hasSums) { Fail 'Could not find a valid GitHub release. Retry later.' }
    Step "Running npm install -g github:OnurSamett/tokenwise-studio#$tag"
    & npm.cmd install -g --ignore-scripts "github:OnurSamett/tokenwise-studio#$tag"
    if ($LASTEXITCODE -ne 0) { Fail 'npm installation failed. Check network access and npm global prefix permissions, then retry.' }
    Step '4/4 Installation complete (Windows beta)'
    Write-Host 'Open a project folder in your terminal, then run:'
    Write-Host '  tokenwise-studio --browser'
    Write-Host 'If PowerShell blocks the .ps1 shim, use: tokenwise-studio.cmd --browser'
    Write-Host 'If the command is not found, add the directory reported by npm.cmd prefix -g to PATH and reopen the terminal.'
    Write-Host 'Requires git and at least one signed-in worker CLI. Run tokenwise-studio.cmd doctor to check.'
    Write-Host 'This installer uses the browser UI. Desktop beta: https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip'
    Write-Host 'Desktop beta is unsigned (SmartScreen: More info -> Run anyway), not yet tested on real hardware. Native dictation, Roblox playtest and Sparkle updates are Mac-only.'
}

# check-current.ps1
#
# Answers "am I running the latest?" without guessing.
#
# Every change we make leaves a distinctive string somewhere. This looks for
# those strings in your working copy, then checks whether that copy is
# committed and pushed, and finally whether the live site is serving it.
#
#   .\check-current.ps1

$repo = "C:\projects\thruscan"
Set-Location $repo

# One marker per change, newest first. A missing marker means that file on disk
# is older than the version you were given.
$markers = [ordered]@{
  "src/lib/game2048.js  RNG mirror"        = @("src\lib\game2048.js", "export function spawnTile")
  "src/App.jsx          move queue"        = @("src\App.jsx", "draining.current")
  "src/App.jsx          tx history toggle" = @("src\App.jsx", "showHistory")
  "src/App.jsx          game picker cards" = @("src\App.jsx", "game-picker")
  "src/App.jsx          native keyboard"   = @("src\App.jsx", "board-input")
  "src/App.jsx          player code"       = @("src\App.jsx", "function PlayerCode")
  "src/App.jsx          icon nav"          = @("src\App.jsx", "function Icon(")
  "src/styles.css       2048 board"        = @("src\styles.css", ".grid2048")
  "src/styles.css       picker cards"      = @("src\styles.css", ".game-picker")
  "api/move-2048.js     exists"            = @("api\move-2048.js", "buildMove")
  "api/submit-game.js   new SDK"           = @("api\submit-game.js", "@thru/sdk")
  "api/post-message.js  new SDK"           = @("api\post-message.js", "@thru/sdk")
  "api/rpc.js           new SDK"           = @("api\rpc.js", "@thru/sdk")
}

Write-Host ""
Write-Host "Files on disk" -ForegroundColor White
Write-Host ("-" * 52) -ForegroundColor DarkGray

$missing = 0
foreach ($label in $markers.Keys) {
  $path, $needle = $markers[$label]
  Write-Host ("  {0,-38}" -f $label) -NoNewline
  if (-not (Test-Path $path)) {
    Write-Host "NO FILE" -ForegroundColor Red; $missing++; continue
  }
  if (Select-String -Path $path -Pattern ([regex]::Escape($needle)) -Quiet) {
    Write-Host "ok" -ForegroundColor Green
  } else {
    Write-Host "OLD" -ForegroundColor Red; $missing++
  }
}

# Anything still importing the deprecated SDK signs transactions the node will
# reject, so it is worth calling out on its own.
$stale = Select-String -Path "src\lib\*.js", "api\*.js" -Pattern "from '@thru/thru-sdk'" -ErrorAction SilentlyContinue
Write-Host ("  {0,-38}" -f "no files on the old SDK") -NoNewline
if ($stale) { Write-Host "OLD" -ForegroundColor Red; $stale | ForEach-Object { Write-Host "      $($_.Filename)" -ForegroundColor DarkGray }; $missing++ }
else { Write-Host "ok" -ForegroundColor Green }

Write-Host ""
Write-Host "Git" -ForegroundColor White
Write-Host ("-" * 52) -ForegroundColor DarkGray

$dirty = git status --porcelain
Write-Host ("  {0,-38}" -f "everything committed") -NoNewline
if ($dirty) {
  Write-Host "NO" -ForegroundColor Yellow
  $dirty -split "`n" | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
} else { Write-Host "ok" -ForegroundColor Green }

git fetch --quiet 2>$null
$ahead = (git rev-list --count '@{u}..HEAD' 2>$null)
Write-Host ("  {0,-38}" -f "pushed to GitHub") -NoNewline
if ($ahead -and [int]$ahead -gt 0) { Write-Host "$ahead commit(s) NOT pushed" -ForegroundColor Yellow }
else { Write-Host "ok" -ForegroundColor Green }

$local = (git rev-parse --short HEAD)
Write-Host ("  {0,-38}{1}" -f "local commit", $local) -ForegroundColor Gray

Write-Host ""
Write-Host "Live site" -ForegroundColor White
Write-Host ("-" * 52) -ForegroundColor DarkGray

# The endpoints only answer if they exist in the deployed build, so a 404 here
# means the push has not gone out yet.
foreach ($api in @("rpc?action=endpoint", "get-content")) {
  Write-Host ("  {0,-38}" -f "/api/$($api.Split('?')[0])") -NoNewline
  try {
    $null = Invoke-RestMethod "https://thruscan.vercel.app/api/$api" -TimeoutSec 15
    Write-Host "live" -ForegroundColor Green
  } catch {
    Write-Host "not there" -ForegroundColor Red
  }
}

Write-Host ""
if ($missing -eq 0 -and -not $dirty) {
  Write-Host "  Everything on disk is current and committed." -ForegroundColor Green
} elseif ($missing -gt 0) {
  Write-Host "  $missing file(s) are older than the versions you were given." -ForegroundColor Yellow
  Write-Host "  Check C:\Users\hp for numbered downloads like 'App (1).jsx'." -ForegroundColor Yellow
} else {
  Write-Host "  Files are current but not committed. Commit and push." -ForegroundColor Yellow
}
Write-Host ""

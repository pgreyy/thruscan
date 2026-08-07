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
  "src/lib/identity.js  registry"        = @("src\lib\identity.js", "decodeRegistry")
  "api/play.js          merged"           = @("api\play.js", "2048-move")
  "src/App.jsx          identity panel"   = @("src\App.jsx", "function Identity")
  "src/lib/game2048.js  RNG mirror"        = @("src\lib\game2048.js", "export function spawnTile")
  "src/App.jsx          no-bounce guard"   = @("src\App.jsx", "movesMade.current")
  "src/App.jsx          move queue"        = @("src\App.jsx", "draining.current")
  "src/App.jsx          tx history toggle" = @("src\App.jsx", "showHistory")
  "src/App.jsx          game picker cards" = @("src\App.jsx", "game-picker")
  "src/App.jsx          native keyboard"   = @("src\App.jsx", "board-input")
  "src/App.jsx          portable code"     = @("src\App.jsx", "setPlayerId")
  "src/App.jsx          icon nav"          = @("src\App.jsx", "function Icon(")
  "src/styles.css       2048 board"        = @("src\styles.css", ".grid2048")
  "src/styles.css       picker cards"      = @("src\styles.css", ".game-picker")
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
Write-Host "Deployed configuration" -ForegroundColor White
Write-Host ("-" * 52) -ForegroundColor DarkGray

# Each endpoint answers differently depending on whether its environment
# variables exist. Sending a deliberately invalid payload separates the two:
# a 503 means the variables are missing, a 400 means it got far enough to
# reject the payload, which is exactly what a configured endpoint does.
$endpoints = @(
  @{ path = "play";         label = "games and names" },
  @{ path = "post-message"; label = "wall" }
)

$unconfigured = 0
foreach ($e in $endpoints) {
  Write-Host ("  {0,-38}" -f $e.label) -NoNewline
  try {
    $null = Invoke-RestMethod "https://thruscan.vercel.app/api/$($e.path)" -Method Post `
      -ContentType "application/json" -Body '{}' -TimeoutSec 20
    Write-Host "unexpected pass" -ForegroundColor Yellow
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    switch ($code) {
      400 { Write-Host "configured" -ForegroundColor Green }
      429 { Write-Host "configured (rate limited)" -ForegroundColor Green }
      503 { Write-Host "ENV VARS MISSING" -ForegroundColor Red; $unconfigured++ }
      404 { Write-Host "NOT DEPLOYED" -ForegroundColor Red; $unconfigured++ }
      default { Write-Host "HTTP $code" -ForegroundColor Yellow }
    }
  }
}

Write-Host ""
Write-Host "Deployed front end" -ForegroundColor White
Write-Host ("-" * 52) -ForegroundColor DarkGray

# VITE_ variables are compiled into the bundle at build time, so the only way
# to know they took is to look inside the JavaScript the site is serving.
try {
  $html = (Invoke-WebRequest "https://thruscan.vercel.app/" -TimeoutSec 20 -UseBasicParsing).Content
  $asset = [regex]::Match($html, 'src="(/assets/[^"]+\.js)"').Groups[1].Value

  if (-not $asset) {
    Write-Host "  could not find the bundle to inspect" -ForegroundColor Yellow
  } else {
    $js = (Invoke-WebRequest "https://thruscan.vercel.app$asset" -TimeoutSec 30 -UseBasicParsing).Content

    $baked = [ordered]@{
      "wall account"     = "taq-jVKlLJwPlmwGdgzC0aVccr8u-OwkRPuAUJNDBHn7c4"
      "wordle board"     = "taBkrwefMZJB_eBROeib98YKLWJVfqFk0res1Idjk5VggB"
      "2048 board"       = "ta5pJNlm-pH-IcgLkZKfRYD-2bD6H8InvY6HIFOzpE0aSc"
      "name registry"    = "takVGpRqWnanA6R1R_IjPBCkCMkP_dwRxTYd6tguNPe8Ox"
    }

    foreach ($k in $baked.Keys) {
      Write-Host ("  {0,-38}" -f "VITE $k") -NoNewline
      if ($js.Contains($baked[$k])) { Write-Host "in bundle" -ForegroundColor Green }
      else { Write-Host "MISSING" -ForegroundColor Red; $unconfigured++ }
    }

    # Something only the newest build contains, to catch a stale deploy.
    Write-Host ("  {0,-38}" -f "identity panel shipped") -NoNewline
    if ($js.Contains("Claim a name")) { Write-Host "yes" -ForegroundColor Green }
    else { Write-Host "OLD BUILD" -ForegroundColor Red; $unconfigured++ }
  }
} catch {
  Write-Host "  could not read the deployed site" -ForegroundColor Yellow
}

Write-Host ""
if ($missing -eq 0 -and -not $dirty -and $unconfigured -eq 0) {
  Write-Host "  Everything is current, committed and live." -ForegroundColor Green
} elseif ($unconfigured -gt 0 -and $missing -eq 0 -and -not $dirty) {
  Write-Host "  Code is current, but $unconfigured thing(s) are not live yet." -ForegroundColor Yellow
  Write-Host "  ENV VARS MISSING -> add them in Vercel, then redeploy." -ForegroundColor Yellow
  Write-Host "  MISSING from bundle -> a VITE_ variable was added after the last" -ForegroundColor Yellow
  Write-Host "  build, so push an empty commit to rebuild:" -ForegroundColor Yellow
  Write-Host "    git commit --allow-empty -m rebuild; git push" -ForegroundColor Yellow
} elseif ($missing -gt 0) {
  Write-Host "  $missing file(s) are older than the versions you were given." -ForegroundColor Yellow
  Write-Host "  Check C:\Users\hp for numbered downloads like 'App (1).jsx'." -ForegroundColor Yellow
} else {
  Write-Host "  Files are current but not committed. Commit and push." -ForegroundColor Yellow
}
Write-Host ""

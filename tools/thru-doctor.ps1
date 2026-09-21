# thru-doctor.ps1
#
# Works out whether a Thru alphanet failure is on your machine or on the
# network, by testing four layers in order and reporting where things stop
# working. Read-only apart from two tiny writes, both using your own account.
#
#   1. Can we reach the node at all?
#   2. Is the chain alive and advancing?
#   3. Do reads work?
#   4. Do writes work, and specifically do the ones needing a state proof?
#
# Layer 4 is the interesting one. Thru has two kinds of write: ordinary ones
# that just pay a fee, and ones that need a cryptographic state proof (creating
# accounts, deploying programs). If ordinary writes pass and proof-backed ones
# fail, the fault is in proof handling on the node, not in anything you did.
#
# Usage:
#   .\thru-doctor.ps1                 # uses key "newkey"
#   .\thru-doctor.ps1 -KeyName mykey

param(
  [string]$KeyName = "newkey",
  [string]$Url = "https://rpc.alphanet.thru.org"
)

$ErrorActionPreference = "Continue"
$results = [ordered]@{}

function Section($text) {
  Write-Host ""
  Write-Host "== $text " -ForegroundColor Cyan -NoNewline
  Write-Host ("=" * [Math]::Max(0, 58 - $text.Length)) -ForegroundColor DarkGray
}

function Try-Step($label, $block, [switch]$Cmdlet) {
  Write-Host ("  {0,-38}" -f $label) -NoNewline
  try {
    $global:LASTEXITCODE = 0
    $out = & $block 2>&1 | Out-String
    # Cmdlets like Resolve-DnsName never set an exit code, so checking it there
    # reads whatever the last external program left behind.
    $exitBad = (-not $Cmdlet) -and ($LASTEXITCODE -ne 0)
    if ($exitBad -or $out -match '"error"|^Error:|error:') {
      Write-Host "FAIL" -ForegroundColor Red
      $script:results[$label] = @{ ok = $false; output = $out.Trim() }
      return $false
    }
    Write-Host "ok" -ForegroundColor Green
    $script:results[$label] = @{ ok = $true; output = $out.Trim() }
    return $true
  } catch {
    Write-Host "FAIL" -ForegroundColor Red
    $script:results[$label] = @{ ok = $false; output = $_.Exception.Message }
    return $false
  }
}

Write-Host ""
Write-Host "Thru doctor" -ForegroundColor White
Write-Host "Endpoint: $Url"
Write-Host "Key:      $KeyName"

# ---------------------------------------------------------------- layer 1
Section "1. Reaching the node"

[void](Try-Step "DNS resolves" { Resolve-DnsName -Name ([Uri]$Url).Host -ErrorAction Stop } -Cmdlet)
$cliOk = Try-Step "CLI responds" { thru --version }
[void](Try-Step "Node answers getversion" { thru --json getversion --url $Url })

if (-not $cliOk) {
  Write-Host ""
  Write-Host "The CLI itself is not working. Fix that before reading further." -ForegroundColor Yellow
  Write-Host "Try: npm install -g thru@latest" -ForegroundColor Yellow
  return
}

# ---------------------------------------------------------------- layer 2
Section "2. Is the chain alive"

[void](Try-Step "Health check" { thru --json gethealth --url $Url })
[void](Try-Step "Consensus status" { thru --json getstatus --url $Url })

$h1 = (thru --json getheight --url $Url 2>&1 | Out-String)
Start-Sleep -Seconds 4
$h2 = (thru --json getheight --url $Url 2>&1 | Out-String)

# Blocks should advance in four seconds. A frozen height means the chain has
# stalled, which is a very different problem from a rejected transaction.
$n1 = [regex]::Matches($h1, '\d{4,}') | ForEach-Object { [long]$_.Value } | Measure-Object -Maximum
$n2 = [regex]::Matches($h2, '\d{4,}') | ForEach-Object { [long]$_.Value } | Measure-Object -Maximum
Write-Host ("  {0,-38}" -f "Blocks advancing") -NoNewline
if ($n2.Maximum -gt $n1.Maximum) {
  Write-Host ("ok  ({0} -> {1})" -f $n1.Maximum, $n2.Maximum) -ForegroundColor Green
  $results["Blocks advancing"] = @{ ok = $true; output = "$($n1.Maximum) -> $($n2.Maximum)" }
} else {
  Write-Host ("STALLED at {0}" -f $n1.Maximum) -ForegroundColor Red
  $results["Blocks advancing"] = @{ ok = $false; output = "stalled at $($n1.Maximum)" }
}

# ---------------------------------------------------------------- layer 3
Section "3. Do reads work"

$readOk = Try-Step "Read your account" { thru --json getaccountinfo $KeyName --url $Url }
[void](Try-Step "Read the genesis program" { thru --json getaccountinfo taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --url $Url })
[void](Try-Step "Read your balance" { thru --json getbalance $KeyName --url $Url })

# ---------------------------------------------------------------- layer 4
Section "4. Do writes work"

# An ordinary write with no state proof: the faucet moves tokens to an account
# that already exists. A transfer to yourself does NOT work as a test, because
# a transaction cannot list the same account twice.
$plainWriteOk = Try-Step "Plain write (faucet withdraw 1)" {
  thru --json faucet withdraw $KeyName 1 --url $Url --fee-payer $KeyName
}

# A second plain write through a program rather than the faucet, so one
# program misbehaving does not look like a general write failure.
$progWriteOk = Try-Step "Plain write via a program" {
  thru --json faucet deposit $KeyName 1 --url $Url --fee-payer $KeyName
}

# Proof generation on its own, without submitting anything. Both types, since
# they take different paths through the node.
$proofExisting = Try-Step "Make proof (existing)" {
  thru --json txn make-state-proof existing $KeyName --url $Url
}
$proofUpdating = Try-Step "Make proof (updating)" {
  thru --json txn make-state-proof updating $KeyName --url $Url
}

# A proof-backed write. This is the operation that has been failing: account
# creation and program deployment both go through this path.
Write-Host ("  {0,-38}" -f "Proof-backed write (create account)") -NoNewline
$probeKey = "doctorprobe$((Get-Random -Maximum 99999))"
thru keys generate $probeKey *> $null
$createOut = (thru account create $probeKey --url $Url 2>&1 | Out-String)
$createOk = ($createOut -notmatch 'Error:|error:|failed')
if ($createOk) {
  Write-Host "ok" -ForegroundColor Green
} else {
  Write-Host "FAIL" -ForegroundColor Red
}
$results["Proof-backed write"] = @{ ok = $createOk; output = $createOut.Trim() }

# ---------------------------------------------------------------- verdict
Section "Verdict"

$chainAlive = $results["Blocks advancing"].ok
$reads = $readOk

if (-not $chainAlive) {
  Write-Host "  The chain is not producing blocks. Everything else is downstream" -ForegroundColor Yellow
  Write-Host "  of that. Nothing you can fix locally." -ForegroundColor Yellow
}
elseif (-not $reads) {
  Write-Host "  The chain is alive but reads are failing, which usually means a" -ForegroundColor Yellow
  Write-Host "  local problem: wrong endpoint, DNS, or a firewall." -ForegroundColor Yellow
}
elseif (($plainWriteOk -or $progWriteOk) -and -not $createOk) {
  Write-Host "  NETWORK SIDE, and specifically state proofs." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Reads work. Ordinary writes work. Only the writes that need a" -ForegroundColor Yellow
  Write-Host "  state proof fail, which covers creating accounts and deploying" -ForegroundColor Yellow
  Write-Host "  programs. Nothing on your machine causes that pattern." -ForegroundColor Yellow
  Write-Host ""
  if ($proofExisting -or $proofUpdating) {
    Write-Host "  Proofs are being CREATED fine, so the fault is in validating" -ForegroundColor Yellow
    Write-Host "  them on chain, not in producing them." -ForegroundColor Yellow
  } else {
    Write-Host "  The node cannot even produce a proof, so the fault is earlier" -ForegroundColor Yellow
    Write-Host "  than validation." -ForegroundColor Yellow
  }
}
elseif (-not $plainWriteOk -and -not $progWriteOk -and -not $createOk) {
  Write-Host "  NETWORK SIDE. No writes are landing at all, proof-backed or not." -ForegroundColor Yellow
  Write-Host "  Check your balance is above zero, then wait it out." -ForegroundColor Yellow
}
elseif ($plainWriteOk -and $createOk) {
  Write-Host "  EVERYTHING WORKS. Whatever was failing has been fixed." -ForegroundColor Green
  Write-Host "  Go deploy." -ForegroundColor Green
}
else {
  Write-Host "  Mixed results, see the detail below." -ForegroundColor Yellow
}

# ---------------------------------------------------------------- detail
Section "Failure detail"

$anyFail = $false
foreach ($k in $results.Keys) {
  if (-not $results[$k].ok) {
    $anyFail = $true
    Write-Host ""
    Write-Host "  $k" -ForegroundColor Red
    ($results[$k].output -split "`n" | Select-Object -First 30) | ForEach-Object {
      Write-Host "    $_" -ForegroundColor DarkGray
    }
  }
}
if (-not $anyFail) { Write-Host "  Nothing failed." -ForegroundColor Green }

Write-Host ""
Write-Host "Run this again any time. When the proof-backed line turns green," -ForegroundColor White
Write-Host "deployment is unblocked." -ForegroundColor White
Write-Host ""

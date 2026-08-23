# Drives the REAL Handle-Search out of fileserver.ps1 against a live stub
# backend. It lifts the function via the AST rather than reimplementing it:
# a test that reimplements what it tests proves nothing about the shipped code.
#
#   pwsh -NoProfile -File test-search-seam.ps1
#
# Asserts the four things the seam has to get right, including the default,
# because the whole promise is that an install with nothing configured does not
# move.

$ErrorActionPreference = 'Stop'
$fail = 0
function Check([string]$name, [bool]$cond, [string]$detail = '') {
    if ($cond) { Write-Host "  PASS  $name" }
    else { $script:fail++; Write-Host "  FAIL  $name  $detail" }
}

# --- lift the real function ---------------------------------------------------
$errs = $null; $toks = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path "$PSScriptRoot/fileserver.ps1").Path, [ref]$toks, [ref]$errs)
if ($errs) { throw "fileserver.ps1 does not parse: $($errs.Count) error(s)" }
$fn = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -eq 'Handle-Search' }, $true) | Select-Object -First 1
if (-not $fn) { throw 'Handle-Search not found — it moved or was renamed' }
Invoke-Expression $fn.Extent.Text

# The two response helpers, capturing instead of writing to a socket.
$script:Captured = $null
function Write-Json { param($Response, [int]$Status, $Object)
    $script:Captured = @{ status = $Status; body = ($Object | ConvertTo-Json -Depth 8 -Compress) } }
function Write-Text { param($Response, [int]$Status, [string]$ContentType, [string]$Body)
    $script:Captured = @{ status = $Status; body = $Body } }

function New-Req([string]$json, [string]$auth = $null) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $h = @{}
    if ($auth) { $h['Authorization'] = $auth }
    [pscustomobject]@{ InputStream = (New-Object System.IO.MemoryStream(,$bytes)); Headers = $h }
}

# --- a stub backend, so the http branch is exercised for real ------------------
$listener = New-Object System.Net.HttpListener
$port = 18731
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
$script:LastPayload = $null
$job = Start-ThreadJob -ScriptBlock {
    param($l)
    $ctx = $l.GetContext()
    $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream)
    $received = $sr.ReadToEnd(); $sr.Close()
    # `snippet`, deliberately: the field-name fallback is the half that fails silently.
    $out = '{"results":[{"title":"T","url":"http://e.example","snippet":"S"}]}'
    $b = [System.Text.Encoding]::UTF8.GetBytes($out)
    $ctx.Response.ContentLength64 = $b.Length
    $ctx.Response.OutputStream.Write($b, 0, $b.Length)
    $ctx.Response.Close()
    $received
} -ArgumentList $listener

try {
    # 1. DEFAULT: nothing configured -> Ollama, unchanged.
    $env:SEARCH_PROVIDER = $null; $env:SEARCH_URL = $null
    $script:Captured = $null
    Handle-Search -Request (New-Req '{"query":"x"}') -Response $null -SubPath '/web_search'
    # No key and no network in CI, so this ends in a 502 from the ollama call --
    # what matters is that it TRIED Ollama rather than the http branch.
    Check 'default with nothing set still goes to Ollama' `
        ($script:Captured.status -eq 502 -and $script:Captured.body -notmatch 'SEARCH_URL') `
        $script:Captured.body

    # 2. SEARCH_PROVIDER=http with no SEARCH_URL is an ERROR, never a silent fallback.
    $env:SEARCH_PROVIDER = 'http'; $env:SEARCH_URL = $null
    $script:Captured = $null
    Handle-Search -Request (New-Req '{"query":"x"}') -Response $null -SubPath '/web_search'
    Check 'explicit http with no SEARCH_URL reports it' `
        ($script:Captured.status -eq 502 -and $script:Captured.body -match 'SEARCH_URL') `
        $script:Captured.body

    # 3. SEARCH_URL set, provider auto -> the http branch, no key needed.
    $env:SEARCH_PROVIDER = $null; $env:SEARCH_URL = "http://127.0.0.1:$port/search"
    $script:Captured = $null
    Handle-Search -Request (New-Req '{"query":"goblins","max_results":3}') -Response $null -SubPath '/web_search'
    Check 'auto + SEARCH_URL uses the http backend' ($script:Captured.status -eq 200) $script:Captured.body
    $res = $script:Captured.body | ConvertFrom-Json
    Check 'results come back as a NON-EMPTY list' `
        (@($res.results).Count -eq 1) $script:Captured.body
    Check 'a `snippet` field is read as content' `
        ($res.results[0].content -eq 'S') "content=$($res.results[0].content)"

    $sent = Receive-Job $job -Wait
    Check 'the backend is asked in the documented shape' `
        ($sent -match '"query"' -and $sent -match '"max_results"') $sent

    # 4. Pinning ollama beats SEARCH_URL being set.
    $env:SEARCH_PROVIDER = 'ollama'
    $script:Captured = $null
    Handle-Search -Request (New-Req '{"query":"x"}') -Response $null -SubPath '/web_search'
    Check 'SEARCH_PROVIDER=ollama overrides a set SEARCH_URL' `
        ($script:Captured.status -eq 502 -and $script:Captured.body -notmatch 'SEARCH_URL') `
        $script:Captured.body
}
finally {
    $listener.Stop(); $listener.Close()
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    $env:SEARCH_PROVIDER = $null; $env:SEARCH_URL = $null
}

Write-Host ""
if ($fail -eq 0) { Write-Host 'PASSED' } else { Write-Host "FAILED ($fail)" }
exit $fail

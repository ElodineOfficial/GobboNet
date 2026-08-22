<#
    hw-recommend.ps1 -- pick a recommended model and mark the menu.

    This was 1,003 characters of PowerShell inlined into a `powershell
    -Command "..."` call in launch.bat. Two reasons it moved:

      1. Inline PowerShell invoked from cmd is closer in shape to payload
         staging than a script file is, and antivirus weights it that way.
         A .ps1 on disk gets AMSI-scanned in plaintext and reads as what it
         is. This release removed an -EncodedCommand blob for the same
         reason; a kilobyte of semicolon-chained one-liner was the next
         worst offender.

      2. The VRAM table below is edited every time the model catalogue
         changes, and it was previously unreadable and untestable -- one
         long line, duplicated from launch.bat's own PICK_MIN list. It is
         now legible, and the two tables can be diffed.

    Contract with launch.bat, unchanged from the inline version:
      reads   hardware.json beside this script
      writes  KEY=VALUE lines on stdout, redirected to .hw-parsed.env
      never   fails in a way that stops the launcher -- an unreadable or
              missing hardware.json yields HW_OK=0 and a static menu.
#>

$ErrorActionPreference = 'SilentlyContinue'

# Minimum VRAM in GB per catalogue slot.
#
# MUST match the PICK_MIN list in launch.bat. They are separate because one
# is consumed by batch and one by PowerShell; if they drift, the menu warns
# about a different threshold than the one that actually gates the download.
$min = @{
    1 = 6      # Gemma 4 E4B IT            ~5.4 GB
    2 = 4      # Llama 3.2 3B Instruct     ~3.4 GB
    3 = 8      # Mistral 7B v0.3           ~7.5 GB
    4 = 8      # Qwen3.5 9B                ~6.2 GB
    5 = 16     # Gemma 4 26B-A4B MoE       ~16 GB
    6 = 24     # Qwen3.6 35B-A3B MoE       ~22 GB  (largest in the catalogue)
    7 = 10     # DeepSeek-R1 8B            ~8.5 GB
    8 = 12     # gpt-oss 20B               ~12 GB
    9 = 8      # Command R 7B              ~6.6 GB
    10 = 24    # Command R 35B             ~19 GB
}

$hwPath = Join-Path $PSScriptRoot 'hardware.json'
$h = $null
try {
    if (Test-Path -LiteralPath $hwPath) {
        $h = ConvertFrom-Json (Get-Content -Raw -LiteralPath $hwPath)
    }
} catch {
    $h = $null
}

# No probe data: emit a neutral set so the menu renders statically rather
# than half-populated. launch.bat treats HW_OK=0 as "print the plain list".
if (-not $h) {
    'HW_OK=0'
    'REC=0'
    'HW_TIER=unknown'
    'HW_VRAM=0'
    'HW_RAM=0'
    'HW_DISK=0'
    foreach ($i in 1..10) { 'MK_' + $i + '=' }
    exit 0
}

$v    = [int]$h.gpu.vram_gb
$t    = [string]$h.recommended_tier
$ram  = [int]$h.ram_gb
$disk = [int]$h.disk.free_gb

# Flagship-first: the best model that fits, not the smallest that works.
# Deliberately stops at slot 5 rather than recommending slot 6 to a 24 GB
# card -- 22 GB of weights leaves under 2 GB for the KV cache, and a
# recommendation that fails to load is worse than a conservative one.
$rec = 0
if     ($t -eq 'cpu_only') { $rec = 2 }
elseif ($v -ge 16)         { $rec = 5 }
elseif ($v -ge 12)         { $rec = 8 }
elseif ($v -ge 8)          { $rec = 4 }
elseif ($v -ge 6)          { $rec = 1 }
else                       { $rec = 2 }

'HW_OK=1'
'HW_TIER=' + $t
'HW_VRAM=' + $v
'HW_RAM=' + $ram
'HW_DISK=' + $disk
'REC=' + $rec

foreach ($i in 1..10) {
    if ($i -eq $rec) {
        $m = '[ RECOMMENDED FOR YOUR PC ]'
    } elseif ($t -eq 'cpu_only') {
        # Without a GPU, anything past the smallest tier is unusably slow
        # rather than merely slower, so say so instead of showing a VRAM
        # figure that does not apply.
        if ($min[$i] -le 6) { $m = '' } else { $m = '[ likely too slow without a GPU ]' }
    } elseif ($v -ge $min[$i]) {
        $m = ''
    } else {
        $m = '[ needs ~' + $min[$i] + ' GB VRAM - will be slow ]'
    }
    'MK_' + $i + '=' + $m
}

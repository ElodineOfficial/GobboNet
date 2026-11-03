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
# gen-catalog.py refuses to build a catalogue when they disagree.
#
# Each figure is the model's download size plus 2 GB, because weights are not
# the only thing that has to fit: the KV cache, llama.cpp's compute buffers
# and the display itself all come out of the same card. These used to be set
# to the download size alone, which made the pre-download warning unreachable
# for exactly the cards that needed it -- a 12 GB card asked for a 12 GB model
# and 12 >= 12 waved it through (issue #23).
#
# Raised, never lowered. Slot 10 already demanded more than size+2 and that
# judgement is left as it was.
$min = @{
    1 = 8      # Gemma 4 E4B IT            ~5.4 GB
    2 = 6      # Llama 3.2 3B Instruct     ~3.4 GB
    3 = 10     # Mistral 7B v0.3           ~7.5 GB
    4 = 9      # Qwen3.5 9B                ~6.2 GB
    5 = 18     # Gemma 4 26B-A4B MoE       ~16 GB
    6 = 24     # Qwen3.6 35B-A3B MoE       ~22 GB  (largest in the catalogue)
    7 = 11     # DeepSeek-R1 8B            ~8.5 GB
    8 = 14     # gpt-oss 20B               ~12 GB
    9 = 9      # Command R 7B              ~6.6 GB
    10 = 24    # Command R 35B             ~19 GB
    12 = 4     # Llama 3.2 1B Instruct     ~1.3 GB  (smallest in the catalogue)
    13 = 10    # Mistral Nemo 12B          ~7.5 GB
    14 = 12    # Phi-4 14B                 ~9.1 GB
    15 = 18    # Mistral Small 3.2 24B     ~14.3 GB
    16 = 24    # Gemma 4 31B IT            ~19.6 GB
    17 = 22    # Qwen3-Coder 30B-A3B MoE   ~18.6 GB
}

# Mixture-of-Experts models also fit a smaller card, when system RAM can hold
# the experts that do not fit on it (issue #65).
#
# Only a few billion of their parameters are active per token, and automatic
# placement keeps the dense part on the GPU and most experts in RAM. Measured
# on an 8 GB RTX 4070 Laptop with 31.6 GB RAM, once placement left them 2 GB of
# headroom (PR #66): Qwen3.6 35B-A3B 21.6 t/s, gpt-oss 20B 20.3 t/s, Gemma 4
# 26B-A4B 21.3 t/s. The $min figures above are what the WHOLE model needs on
# the card, which is why the menu used to call all three "too slow" there.
#
# $moeVram is the smallest card they were measured on. $moeRam is the system
# RAM each needs beside it: the download, less the ~6 GB an 8 GB card holds,
# plus ~10 GB for Windows, the browser and the KV cache, rounded up to a common
# RAM size. MUST match MOE_MIN_VRAM and the PICK_MOE_RAM list in launch.bat;
# gen-catalog.py refuses to build a catalogue when they disagree.
$moeVram = 8
$moeRam = @{
    5 = 24     # Gemma 4 26B-A4B MoE       ~16 GB
    6 = 32     # Qwen3.6 35B-A3B MoE       ~22 GB
    8 = 16     # gpt-oss 20B               ~12 GB
    17 = 24    # Qwen3-Coder 30B-A3B MoE   ~18.6 GB
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
    foreach ($i in (1..10 + 12..17)) { 'MK_' + $i + '=' }
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
#
# That same reasoning had not been applied to the rungs below it. Each
# threshold was the model's download size, so three of the four rungs offered
# a model that filled the card exactly:
#
#     16 GB -> Gemma 4 26B (16 GB file)   0.0 GB spare
#     12 GB -> gpt-oss 20B (12 GB file)   0.0 GB spare
#      6 GB -> Gemma 4 E4B (5.4 GB file)  0.6 GB spare
#
# Only the middle one was reported (#23), on an RTX 4070 where llama.cpp
# found 11,030 MiB free against an 11.28 GiB model -- the weights alone did
# not fit, before any cache. The other two are the same bug on other cards.
#
# Every rung now leaves at least 2 GB, the headroom_gb the catalogue schema
# already defines. Slot 5 keeps the biggest cards; gpt-oss moves up to the
# 16 GB rung where it has room; 12 GB gets Qwen3.5 9B, which is what #39
# proposed and what the issue thread expects.
$rec = 0
if     ($t -eq 'cpu_only') { $rec = 2 }
elseif ($v -ge 20)         { $rec = 5 }
elseif ($v -ge 16)         { $rec = 8 }
elseif ($v -ge 12)         { $rec = 4 }
elseif ($v -ge 8)          { $rec = 1 }
else                       { $rec = 2 }

'HW_OK=1'
'HW_TIER=' + $t
'HW_VRAM=' + $v
'HW_RAM=' + $ram
'HW_DISK=' + $disk
'REC=' + $rec

foreach ($i in (1..10 + 12..17)) {
    if ($i -eq $rec) {
        $m = '[ RECOMMENDED FOR YOUR PC ]'
    } elseif ($t -eq 'cpu_only') {
        # Without a GPU, anything past the smallest tier is unusably slow
        # rather than merely slower, so say so instead of showing a VRAM
        # figure that does not apply.
        if ($min[$i] -le 6) { $m = '' } else { $m = '[ likely too slow without a GPU ]' }
    } elseif ($v -ge $min[$i]) {
        $m = ''
    } elseif ($moeRam.ContainsKey($i) -and $v -ge $moeVram -and $ram -ge $moeRam[$i]) {
        # Fits, and says how: a plain blank here would leave someone
        # wondering why a 22 GB model is unmarked on an 8 GB card.
        $m = '[ fits: MoE, uses system RAM ]'
    } else {
        $m = '[ needs ~' + $min[$i] + ' GB VRAM - will be slow ]'
    }
    'MK_' + $i + '=' + $m
}

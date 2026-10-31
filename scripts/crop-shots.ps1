# Crop the README screenshots to the plugin's content column.
#
# The browser runs at 2048 CSS px wide with devicePixelRatio 1.25, so the raw
# PNGs are 2560 device px wide. Everything outside the content column (the
# workspace/session sidebar) is personal data and gets cropped away.
#
# Python cannot write files in this environment, so the crop runs through
# System.Drawing here.
#
# Platform: System.Drawing is built into Windows PowerShell 5.1 (what this
# script assumes). PowerShell 7 (pwsh) needs the System.Drawing.Common
# package, and on non-Windows platforms it throws PlatformNotSupportedException.
#
# Single image:
#   .\scripts\crop-shots.ps1 -In screenshot_20261026_214602.178.png `
#       -Out token-usage_zh.png -Rect '630,0,1640,1300'
#
# The rectangle must be exactly four numbers: 'x,y,width,height'. Keep the
# quotes — without them PowerShell turns the value into an array and the
# script cannot read it. A wrong count (3 or 5 numbers) is a hard error on
# purpose: silently falling back to "copy the whole image" would publish an
# uncropped screenshot that still contains the personal sidebar this script
# exists to remove. Omit -Rect entirely to copy the whole image.
#
# An existing output file is never overwritten unless -Force is given.
#
# Batch (JSON job list; "Rect" may be null to copy the whole image):
#   .\scripts\crop-shots.ps1 -Jobs C:\temp\crop-jobs.json
param(
  [string]$In,
  [string]$Out,
  [string]$Rect,
  [string]$Jobs,
  [string]$SourceDir = (Join-Path $env:TEMP 'kimi-webbridge-screenshots'),
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\docs\images'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  throw ("System.Drawing is unavailable: {0}. Windows PowerShell 5.1 has it built in; " +
    "PowerShell 7 needs the System.Drawing.Common package.") -f $_.Exception.Message
}

<#
  .SYNOPSIS
    Normalises a rectangle specification into an int[4] (x, y, width, height).
  .DESCRIPTION
    Returns $null when the specification is absent (the whole image is
    copied). A present but malformed specification throws: falling back to
    "copy everything" here would silently produce an uncropped screenshot
    full of personal data.
#>
function Resolve-Rect {
  param($Value, [string]$Label, [string]$OmitHint = "Omit $Label to copy the whole image.")

  if ($null -eq $Value) { return $null }
  if ($Value -is [string]) {
    # An empty value is an explicit mistake, not "no rectangle": the caller
    # omits the argument entirely when a whole-image copy is meant.
    if ($Value.Trim() -eq '') {
      throw ("{0} is empty. {1}") -f $Label, $OmitHint
    }
    $items = @($Value -split ',')
  } else {
    $items = @($Value)
  }
  if ($items.Count -eq 0) { return $null }
  if ($items.Count -ne 4) {
    throw ("{0} must be exactly 4 numbers in the form 'x,y,width,height' (got {1}: '{2}'). {3}") -f `
      $Label, $items.Count, ($items -join ','), $OmitHint
  }

  $numbers = @()
  foreach ($item in $items) {
    $number = 0
    if (-not [int]::TryParse([string]$item, [ref]$number)) {
      throw ("{0} contains the non-numeric value '{1}'. Use 'x,y,width,height'.") -f $Label, $item
    }
    $numbers += $number
  }
  return , $numbers
}

function Invoke-Crop {
  param([string]$InFile, [string]$OutFile, [int[]]$CropRect, [switch]$Force)

  $inPath = if ([System.IO.Path]::IsPathRooted($InFile)) { $InFile } else { Join-Path $SourceDir $InFile }
  $outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $OutputDir $OutFile }
  $outDir = Split-Path -Parent $outPath
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

  if (-not (Test-Path -LiteralPath $inPath)) { throw "Input image not found: $inPath" }
  if (Test-Path -LiteralPath $outPath) {
    if (-not $Force) { throw "Output file already exists: $outPath (use -Force to overwrite it)." }
    Write-Warning "Overwriting existing output: $outPath"
  }

  $image = [System.Drawing.Image]::FromFile($inPath)
  try {
    if ($null -eq $CropRect -or $CropRect.Count -eq 0) {
      # No rectangle asked for: copy the whole image on purpose.
      $bitmap = New-Object System.Drawing.Bitmap($image)
    } else {
      if ($CropRect.Count -ne 4) {
        throw ("Crop rectangle must be exactly 4 numbers: 'x,y,width,height' (got {0}).") -f $CropRect.Count
      }
      $x = $CropRect[0]; $y = $CropRect[1]; $w = $CropRect[2]; $h = $CropRect[3]
      if ($w -le 0 -or $h -le 0) {
        throw ("Crop rectangle width/height must be positive (got {0}x{1}).") -f $w, $h
      }
      if ($x -lt 0 -or $y -lt 0 -or ($x + $w) -gt $image.Width -or ($y + $h) -gt $image.Height) {
        throw ("Crop rectangle {0},{1},{2},{3} does not fit inside the source image ({4}x{5}).") -f `
          $x, $y, $w, $h, $image.Width, $image.Height
      }
      $bitmap = New-Object System.Drawing.Bitmap($w, $h)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.DrawImage($image,
          (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
          (New-Object System.Drawing.Rectangle($x, $y, $w, $h)),
          [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $graphics.Dispose() }
    }
    try {
      # Write beside the target and rename, so a crash never leaves a
      # half-written PNG in place of a good one. The GUID keeps parallel runs
      # from colliding on the same scratch name.
      $tempPath = Join-Path $outDir ('.{0}.{1}.tmp' -f (Split-Path -Leaf $outPath), [guid]::NewGuid().ToString('N'))
      try {
        $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
        Move-Item -LiteralPath $tempPath -Destination $outPath -Force
      } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
      }
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose() }

  $size = (Get-Item $outPath).Length
  "{0}: {1} KB" -f (Split-Path -Leaf $outPath), [int]($size / 1KB)
}

if ($Jobs) {
  $list = Get-Content -Raw -Encoding UTF8 $Jobs | ConvertFrom-Json
  # Validate every rectangle up front: a malformed job list must abort before
  # anything is written, so no job can quietly slip through as an uncropped
  # full-screen screenshot.
  $resolved = @()
  foreach ($job in $list) {
    $label = "Rect of job '{0}'" -f $job.Out
    $resolved += [pscustomobject]@{
      In = $job.In
      Out = $job.Out
      Rect = (Resolve-Rect $job.Rect $label 'Use a null Rect to copy the whole image.')
    }
  }
  foreach ($item in $resolved) {
    Invoke-Crop -InFile $item.In -OutFile $item.Out -CropRect $item.Rect -Force:$Force
  }
} elseif ($In -and $Out) {
  # Only an omitted -Rect means "copy the whole image"; an explicit (even
  # empty) value must be a valid rectangle.
  $cropRect = if ($PSBoundParameters.ContainsKey('Rect')) { Resolve-Rect $Rect '-Rect' } else { $null }
  Invoke-Crop -InFile $In -OutFile $Out -CropRect $cropRect -Force:$Force
} else {
  throw 'Specify -In/-Out (and optionally -Rect ''x,y,width,height''), or -Jobs <joblist.json>.'
}

# Crop the README screenshots to the plugin's content column.
#
# The browser runs at 2048 CSS px wide with devicePixelRatio 1.25, so the raw
# PNGs are 2560 device px wide. Everything outside the content column (the
# workspace/session sidebar) is personal data and gets cropped away.
#
# Python cannot write files in this environment, so the crop runs through
# System.Drawing here.
#
# Single image:
#   .\scripts\crop-shots.ps1 -In screenshot_20261026_214602.178.png `
#       -Out token-usage_zh.png -Rect 630,0,1640,1300
#
# Batch (JSON job list; "Rect" may be null to copy the whole image):
#   .\scripts\crop-shots.ps1 -Jobs C:\temp\crop-jobs.json
param(
  [string]$In,
  [string]$Out,
  [string]$Rect,
  [string]$Jobs,
  [string]$SourceDir = (Join-Path $env:TEMP 'kimi-webbridge-screenshots'),
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\docs\images')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Invoke-Crop {
  param([string]$InFile, [string]$OutFile, [int[]]$CropRect)

  $inPath = if ([System.IO.Path]::IsPathRooted($InFile)) { $InFile } else { Join-Path $SourceDir $InFile }
  $outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $OutputDir $OutFile }
  $outDir = Split-Path -Parent $outPath
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

  $image = [System.Drawing.Image]::FromFile($inPath)
  try {
    if ($null -eq $CropRect -or $CropRect.Count -ne 4) {
      $bitmap = New-Object System.Drawing.Bitmap($image)
    } else {
      $x = $CropRect[0]; $y = $CropRect[1]; $w = $CropRect[2]; $h = $CropRect[3]
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
      $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose() }

  $size = (Get-Item $outPath).Length
  "{0}: {1} KB" -f (Split-Path -Leaf $outPath), [int]($size / 1KB)
}

function ConvertTo-Rect {
  param($Value)
  if ($null -eq $Value) { return $null }
  return @($Value | ForEach-Object { [int]$_ })
}

if ($Jobs) {
  $list = Get-Content -Raw -Encoding UTF8 $Jobs | ConvertFrom-Json
  foreach ($job in $list) {
    Invoke-Crop -InFile $job.In -OutFile $job.Out -CropRect (ConvertTo-Rect $job.Rect)
  }
} elseif ($In -and $Out) {
  $cropRect = $null
  if ($Rect) { $cropRect = ConvertTo-Rect ($Rect -split ',') }
  Invoke-Crop -InFile $In -OutFile $Out -CropRect $cropRect
} else {
  Write-Error 'Specify -In/-Out (and optionally -Rect x,y,w,h), or -Jobs <joblist.json>.'
  exit 1
}

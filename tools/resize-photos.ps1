# Zmenší fotky pro web a vytvoří náhledy.
# Použití: .\resize-photos.ps1 -Source "C:\...\florbal 2026" -Year 2026
# Výstup:  img\<rok>\NN.jpg (1600 px) a img\<rok>\nahledy\NN.jpg (600 px)
# Metadata (EXIF vč. GPS polohy) se při převodu odstraní.

param(
  [Parameter(Mandatory)] [string] $Source,
  [Parameter(Mandatory)] [string] $Year,
  [int] $Large = 1600,
  [int] $Thumb = 600
)

Add-Type -AssemblyName System.Drawing

$site = Join-Path $PSScriptRoot '..\florbaljivova'
$outDir = Join-Path $site "img\$Year"
$thumbDir = Join-Path $outDir 'nahledy'
New-Item -ItemType Directory -Force -Path $thumbDir | Out-Null

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'

function Save-Resized($img, [int]$max, [string]$path, [long]$quality) {
  $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
  $w = [int][Math]::Round($img.Width * $scale)
  $h = [int][Math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'HighQuality'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($img, 0, 0, $w, $h)
  $p = New-Object System.Drawing.Imaging.EncoderParameters 1
  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $quality
  $bmp.Save($path, $jpeg, $p)
  $g.Dispose(); $bmp.Dispose()
  "{0}x{1}" -f $w, $h
}

# Seřadit podle čísla na začátku názvu (1-, 2-, … 10-), jinak podle názvu
$files = Get-ChildItem $Source -File | Where-Object { $_.Extension -match '^\.(jpe?g|png)$' } |
  Sort-Object @{ e = { if ($_.Name -match '^(\d+)') { [int]$matches[1] } else { [int]::MaxValue } } }, Name

$n = 0
foreach ($f in $files) {
  $n++
  $name = '{0:D2}.jpg' -f $n
  $img = [System.Drawing.Image]::FromFile($f.FullName)
  try {
    # Otočit podle EXIF orientace
    if ($img.PropertyIdList -contains 0x0112) {
      switch ([int]$img.GetPropertyItem(0x0112).Value[0]) {
        3 { $img.RotateFlip('Rotate180FlipNone') }
        6 { $img.RotateFlip('Rotate90FlipNone') }
        8 { $img.RotateFlip('Rotate270FlipNone') }
      }
    }
    $big = Save-Resized $img $Large (Join-Path $outDir $name) 82
    $small = Save-Resized $img $Thumb (Join-Path $thumbDir $name) 75
    "{0} <- {1}  ({2}, thumb {3})" -f $name, $f.Name, $big, $small
  } finally { $img.Dispose() }
}

$sum = (Get-ChildItem $outDir -Recurse -File | Measure-Object Length -Sum).Sum
"Done: $n photos, total {0:N1} MB" -f ($sum / 1MB)

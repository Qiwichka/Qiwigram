# Рисует иконки приложения. Запускать из корня проекта:
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#
# Отдельный скрипт, а не готовые картинки в репозитории: иконку почти
# наверняка захочется переделать, и перерисовка должна быть одной командой.
#
# Файл сохранён в UTF-8 С BOM. Без него PowerShell 5.1 читает кириллицу
# в комментариях как мусор и валится с выдуманными синтаксическими ошибками.

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\icons"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function New-Icon {
    param(
        [int]$Size,
        [string]$OutFile,
        # У maskable-иконки Android обрезает края под свою форму, поэтому
        # рисунок ужимается к центру, иначе буква окажется подрезанной.
        [double]$Inset = 0.0
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $pad = [int]($Size * $Inset)
    $box = $Size - 2 * $pad

    # Фон maskable заливает весь квадрат — вырезать будет система
    if ($Inset -gt 0) {
        $bgColor = [System.Drawing.Color]::FromArgb(255, 109, 47, 214)
        $bg = New-Object System.Drawing.SolidBrush($bgColor)
        $g.FillRectangle($bg, 0, 0, $Size, $Size)
        $bg.Dispose()
    }

    $rect = New-Object System.Drawing.Rectangle($pad, $pad, $box, $box)
    $c1 = [System.Drawing.Color]::FromArgb(255, 123, 63, 228)
    $c2 = [System.Drawing.Color]::FromArgb(255, 176, 110, 245)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

    if ($Inset -eq 0) {
        # Скруглённый квадрат: четыре дуги по углам
        $r = [int]($box * 0.22)
        $d = 2 * $r
        $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $gp.AddArc($pad, $pad, $d, $d, 180, 90)
        $gp.AddArc(($pad + $box - $d), $pad, $d, $d, 270, 90)
        $gp.AddArc(($pad + $box - $d), ($pad + $box - $d), $d, $d, 0, 90)
        $gp.AddArc($pad, ($pad + $box - $d), $d, $d, 90, 90)
        $gp.CloseFigure()
        $g.FillPath($grad, $gp)
        $gp.Dispose()
    } else {
        $g.FillEllipse($grad, $rect)
    }

    $fontSize = [float]($box * 0.56)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    # Буква садится чуть выше центра: хвост Q уходит вниз и оптически
    # перевешивает, если ставить её ровно посередине.
    $ty = [float]($pad - $box * 0.04)
    $textRect = New-Object System.Drawing.RectangleF([float]$pad, $ty, [float]$box, [float]$box)
    $g.DrawString("Q", $font, $white, $textRect, $fmt)

    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)

    $grad.Dispose(); $font.Dispose(); $white.Dispose(); $fmt.Dispose()
    $g.Dispose(); $bmp.Dispose()
    Write-Host ("saved: " + $OutFile)
}

New-Icon -Size 192 -OutFile (Join-Path $outDir "icon-192.png")
New-Icon -Size 512 -OutFile (Join-Path $outDir "icon-512.png")
New-Icon -Size 512 -OutFile (Join-Path $outDir "icon-maskable.png") -Inset 0.18

# ============================================================================
# ИКОНКИ И ЗАСТАВКА ДЛЯ APK
#
# Android берёт иконку не одним файлом, а набором под каждую плотность экрана,
# плюс отдельно «передний план» для адаптивной иконки: систему интересует
# только рисунок, фон она заливает сама и обрезает под форму, принятую
# в лаунчере — круг, квадрат со скруглением или каплю.
#
# Поэтому передний план рисуется на прозрачном фоне и ужимается к середине:
# внешняя треть картинки у адаптивной иконки съедается гарантированно.
# ============================================================================

$androidRes = Join-Path $PSScriptRoot "..\android\app\src\main\res"

function New-Foreground {
    param([int]$Size, [string]$OutFile)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # Безопасная зона адаптивной иконки — центральные две трети
    $pad = [int]($Size * 0.19)
    $box = $Size - 2 * $pad

    $rect = New-Object System.Drawing.Rectangle($pad, $pad, $box, $box)
    $c1 = [System.Drawing.Color]::FromArgb(255, 123, 63, 228)
    $c2 = [System.Drawing.Color]::FromArgb(255, 176, 110, 245)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
    $g.FillEllipse($grad, $rect)

    $font = New-Object System.Drawing.Font("Segoe UI", [float]($box * 0.56), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    $ty = [float]($pad - $box * 0.04)
    $textRect = New-Object System.Drawing.RectangleF([float]$pad, $ty, [float]$box, [float]$box)
    $g.DrawString("Q", $font, $white, $textRect, $fmt)

    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $grad.Dispose(); $font.Dispose(); $white.Dispose(); $fmt.Dispose()
    $g.Dispose(); $bmp.Dispose()
}

# Заставка. Размер берём у той картинки, что лежит на месте: Capacitor
# кладёт свой набор под каждую плотность и ориентацию, и угадывать эти
# размеры вручную — лишний повод ошибиться.
function New-Splash {
    param([string]$File)

    $src = [System.Drawing.Image]::FromFile($File)
    $w = $src.Width
    $h = $src.Height
    $src.Dispose()

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # тот же цвет, что у background_color в манифесте и у theme-color страницы
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 14, 22, 33))
    $g.FillRectangle($bg, 0, 0, $w, $h)
    $bg.Dispose()

    $box = [int]([Math]::Min($w, $h) * 0.28)
    $x = [int](($w - $box) / 2)
    $y = [int](($h - $box) / 2)

    $rect = New-Object System.Drawing.Rectangle($x, $y, $box, $box)
    $c1 = [System.Drawing.Color]::FromArgb(255, 123, 63, 228)
    $c2 = [System.Drawing.Color]::FromArgb(255, 176, 110, 245)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

    $r = [int]($box * 0.22)
    $d = 2 * $r
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc($x, $y, $d, $d, 180, 90)
    $gp.AddArc(($x + $box - $d), $y, $d, $d, 270, 90)
    $gp.AddArc(($x + $box - $d), ($y + $box - $d), $d, $d, 0, 90)
    $gp.AddArc($x, ($y + $box - $d), $d, $d, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($grad, $gp)
    $gp.Dispose()

    $font = New-Object System.Drawing.Font("Segoe UI", [float]($box * 0.56), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    $textRect = New-Object System.Drawing.RectangleF([float]$x, [float]($y - $box * 0.04), [float]$box, [float]$box)
    $g.DrawString("Q", $font, $white, $textRect, $fmt)

    $bmp.Save($File, [System.Drawing.Imaging.ImageFormat]::Png)
    $grad.Dispose(); $font.Dispose(); $white.Dispose(); $fmt.Dispose()
    $g.Dispose(); $bmp.Dispose()
}

if (Test-Path $androidRes) {
    # плотность -> сторона иконки в пикселях
    $densities = [ordered]@{
        "mdpi" = 48; "hdpi" = 72; "xhdpi" = 96; "xxhdpi" = 144; "xxxhdpi" = 192
    }

    foreach ($d in $densities.Keys) {
        $dir = Join-Path $androidRes ("mipmap-" + $d)
        if (-not (Test-Path $dir)) { continue }
        $size = $densities[$d]

        New-Icon -Size $size -OutFile (Join-Path $dir "ic_launcher.png")
        New-Icon -Size $size -OutFile (Join-Path $dir "ic_launcher_round.png") -Inset 0.02
        # передний план адаптивной иконки крупнее самой иконки: 108dp против 48
        New-Foreground -Size ([int]($size * 2.25)) -OutFile (Join-Path $dir "ic_launcher_foreground.png")
    }
    Write-Host "иконки Android перерисованы"

    foreach ($splash in (Get-ChildItem $androidRes -Recurse -Filter "splash.png")) {
        New-Splash -File $splash.FullName
    }
    Write-Host "заставки Android перерисованы"
}

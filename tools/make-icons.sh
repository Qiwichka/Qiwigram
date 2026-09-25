#!/usr/bin/env bash
# Рисует все иконки и заставки Qiwigram из одного рисунка. Запускать из
# корня проекта:
#   bash tools/make-icons.sh
#
# Нужны rsvg-convert (librsvg) и magick (ImageMagick 7).
#
# Знак — кольцо-облачко: стеклянный бублик с главной страницы, которому
# отрастили хвостик реплики. Заодно читается как Q. В середине зелёная
# косточка киви. Всё остальное (размеры, фон, отступы под обрезку Android)
# считается отсюда, поэтому перерисовка знака — правка одной функции mark.

set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BG_DARK="#0c0b11"

# svg <файл> <масштаб знака> <скругление фона: 116 для плитки, 0 — во весь квадрат>
svg() {
    local out=$1 k=$2 rx=$3
    cat > "$out" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
 <radialGradient id="bg" cx="30%" cy="15%" r="95%"><stop offset="0" stop-color="#2c1b55"/><stop offset=".55" stop-color="#15121f"/><stop offset="1" stop-color="$BG_DARK"/></radialGradient>
 <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dcc6ff"/><stop offset=".45" stop-color="#9d6dff"/><stop offset="1" stop-color="#5a2ee0"/></linearGradient>
 <linearGradient id="gloss" gradientUnits="userSpaceOnUse" x1="0" y1="$(awk "BEGIN{print 256-174*$k}")" x2="0" y2="$(awk "BEGIN{print 256+126*$k}")"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <radialGradient id="seed" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#e6ff9a"/><stop offset=".6" stop-color="#a6e84a"/><stop offset="1" stop-color="#6fbf2a"/></radialGradient>
 <mask id="m"><g transform="translate(256 256) scale($k) translate(-268 -264)">
  <circle cx="248" cy="240" r="150" fill="#fff"/>
  <path d="M390 300 C400 360 414 404 436 436 C396 430 344 414 296 382 Z" fill="#fff"/>
  <circle cx="248" cy="240" r="84" fill="#000"/>
 </g></mask>
 <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="$(awk "BEGIN{print 24*$k}")"/></filter>
</defs>
<rect width="512" height="512" rx="$rx" fill="url(#bg)"/>
<g opacity=".6" filter="url(#glow)"><rect width="512" height="512" fill="#8b5cf6" mask="url(#m)"/></g>
<rect width="512" height="512" fill="url(#ring)" mask="url(#m)"/>
<rect width="512" height="512" fill="url(#gloss)" mask="url(#m)"/>
<g transform="translate(256 256) scale($k) translate(-268 -264)"><circle cx="248" cy="240" r="36" fill="url(#seed)"/></g>
</svg>
EOF
}

png() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

# ------------------------------- сайт и PWA -------------------------------

svg icons/logo.svg 1 116                  # плитка: сайт, заставка, интерфейс
svg "$TMP/round.svg" 1 256               # скругление в половину стороны — круг
svg "$TMP/maskable.svg" 0.8 0             # под обрезку лаунчером: знак ужат к центру

png icons/logo.svg 192 icons/icon-192.png
png icons/logo.svg 512 icons/icon-512.png
png "$TMP/maskable.svg" 512 icons/icon-maskable.png

# -------------------------------- Android --------------------------------
# Адаптивная иконка: передний слой 108dp, из них гарантированно видны
# только центральные 66dp — остальное срежет форма лаунчера. Фон нарисован
# прямо в переднем слое, чтобы свечение не обрывалось о плоский цвет.

svg "$TMP/fg.svg" 0.66 0
RES=android/app/src/main/res
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    d=${pair%%:*}; s=${pair##*:}
    fg=$(( s * 108 / 48 ))
    png icons/logo.svg "$s" "$RES/mipmap-$d/ic_launcher.png"
    png "$TMP/round.svg" "$s" "$RES/mipmap-$d/ic_launcher_round.png"
    png "$TMP/fg.svg" "$fg" "$RES/mipmap-$d/ic_launcher_foreground.png"
done

# Заставка при запуске: плитка по центру на цвете полотна приложения
png icons/logo.svg 1024 "$TMP/tile.png"
for f in "$RES"/drawable*/splash.png; do
    read -r w h < <(magick identify -format "%w %h\n" "$f")
    side=$(( (w < h ? w : h) * 28 / 100 ))
    magick -size "${w}x${h}" "xc:$BG_DARK" \( "$TMP/tile.png" -resize "${side}x${side}" \) \
        -gravity center -composite "$f"
done

echo "Иконки готовы"

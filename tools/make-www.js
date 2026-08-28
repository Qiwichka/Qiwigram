/*
 * make-www.js — собирает папку www/, из которой Capacitor лепит APK.
 *
 * В приложение едет не весь сайт. За бортом остаются:
 *
 *   index.html   — лендинг. Он рекламирует мессенджер тому, кто его ещё не
 *                  поставил; человеку с установленным приложением показывать
 *                  рекламную страницу незачем, поэтому стартовой становится
 *                  сам мессенджер.
 *   sw.js        — служебный работник. Внутри приложения файлы и так лежат
 *                  локально, кэшировать нечего, а лишний слой кэша умеет
 *                  только одно: подсунуть старые файлы поверх новой сборки.
 *   manifest     — он объясняет браузеру, как поставить сайт приложением.
 *                  Приложение уже установлено.
 *   db/, tools/  — схема базы и вспомогательные скрипты. В телефоне им
 *                  делать нечего.
 *
 * Запускается сам перед каждой сборкой, руками звать не нужно.
 */

const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const out = path.join(root, "www")

/** Что берём: [откуда, куда]. Куда не указано — то же имя. */
const FILES = [
    ["app.html", "index.html"],   // стартовая страница приложения
    ["security.html"]
]
const DIRS = ["assets", "icons"]

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true })
    for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name)
        const dst = path.join(to, name)
        if (fs.statSync(src).isDirectory()) copyDir(src, dst)
        else fs.copyFileSync(src, dst)
    }
}

// Начисто: файл, выброшенный из сборки, не должен пережить её в старой папке
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

for (const [from, to] of FILES) {
    fs.copyFileSync(path.join(root, from), path.join(out, to || from))
}
for (const dir of DIRS) {
    copyDir(path.join(root, dir), path.join(out, dir))
}

/* Пересчёт того, что получилось: если сборка вдруг уедет пустой, это должно
   быть видно сразу, а не на телефоне с белым экраном. */
let count = 0
let bytes = 0
;(function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        const st = fs.statSync(p)
        if (st.isDirectory()) walk(p)
        else { count++; bytes += st.size }
    }
})(out)

console.log(`www/: ${count} файлов, ${(bytes / 1048576).toFixed(1)} МБ`)
if (count < 10) {
    console.error("Похоже, сборка пустая — проверь пути")
    process.exit(1)
}

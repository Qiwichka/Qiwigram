/*
 * serve.js — крошечный сервер для проверки на своей машине.
 *   node tools/serve.js
 * потом открыть http://localhost:5173
 *
 * Нужен потому, что app.html подключает скрипты как модули, а модули по
 * протоколу file:// браузер запрещает из соображений безопасности. То есть
 * двойным кликом мессенджер не открыть — только через http.
 *
 * Без единой зависимости: ставить пакеты ради тридцати строк незачем,
 * а на слабой машине лишняя сборка это лишние полторы минуты.
 */

const http = require("http")
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const PORT = 5173

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon"
}

const LOG_FILE = path.join(__dirname, "_client.log")

const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0])
    if (rel === "/") rel = "/index.html"

    /* Приёмник сообщений со страницы. Нужен для отладки в браузере, который
     * нельзя расспросить напрямую: страница шлёт сюда, что с ней происходит,
     * и это ложится в файл, который можно прочитать когда угодно — снимок
     * экрана делается по событию загрузки и всё, что случилось позже,
     * попросту не застаёт. */
    if (rel === "/__log") {
        const msg = new URL(req.url, "http://x").searchParams.get("m") || ""
        fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 23) + "  " + msg + "\n")
        res.writeHead(204).end()
        return
    }
    if (rel === "/__log/clear") {
        fs.writeFileSync(LOG_FILE, "")
        res.writeHead(204).end()
        return
    }

    const file = path.join(ROOT, rel)

    // Выход за пределы папки проекта: «/../../Windows/...» не должно
    // отдаваться даже на локальном сервере
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end("nope")
        return
    }

    // Журнал обращений: без него нельзя отличить «страница не работает»
    // от «браузер сюда вообще не приходил»
    fs.appendFile(
        path.join(__dirname, "_access.log"),
        new Date().toISOString().slice(11, 19) + "  " + req.url + "\n",
        () => {}
    )

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
            res.end("не найдено: " + rel)
            return
        }
        res.writeHead(200, {
            "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
            // при разработке кэш только мешает: правишь файл, а браузер
            // показывает вчерашний
            "Cache-Control": "no-store"
        })
        res.end(data)
    })
})

server.listen(PORT, () => {
    console.log(`Qiwigram: http://localhost:${PORT}`)
    console.log(`главная:    http://localhost:${PORT}/index.html`)
    console.log(`мессенджер: http://localhost:${PORT}/app.html`)
    console.log("остановить — Ctrl+C")
})

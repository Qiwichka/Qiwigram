/*
 * sw.js — служебный работник Qiwigram.
 *
 * Кэшируется ТОЛЬКО оболочка: разметка, стили, скрипты, иконки. Ни одно
 * обращение к Supabase здесь не трогается вообще — ни сообщения, ни картинки
 * из хранилища. Причина: закэшированная переписка пережила бы и выход из
 * аккаунта, и самоуничтожение сообщений, то есть ровно то, что мессенджер
 * обещает не делать.
 */

const VERSION = "qiwigram-v4"

const SHELL = [
    "./",
    "index.html",
    "app.html",
    "security.html",
    "manifest.webmanifest",
    "assets/css/landing.css",
    "assets/css/app.css",
    "assets/css/security.css",
    "assets/js/dither.js",
    "assets/vendor/supabase.js",
    "assets/js/glass.js",
    "assets/js/landing.js",
    "assets/js/config.js",
    "assets/js/crypto.js",
    "assets/js/ui.js",
    "assets/js/db.js",
    "assets/js/app.js",
    "icons/icon-192.png",
    "icons/icon-512.png"
]

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(VERSION)
        // По одному, а не addAll: тот падает целиком, если не открылся
        // хотя бы один файл, и обновление молча срывается.
        await Promise.all(SHELL.map((url) =>
            cache.add(url).catch(() => { /* этот файл переживём без кэша */ })
        ))
        self.skipWaiting()
    })())
})

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys()
        await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
        await self.clients.claim()
    })())
})

self.addEventListener("fetch", (event) => {
    const req = event.request
    if (req.method !== "GET") return

    const url = new URL(req.url)

    // Чужие хосты не наше дело: Supabase, шрифты, библиотека с CDN.
    // Пусть идут в сеть напрямую и кэшируются браузером как обычно.
    if (url.origin !== self.location.origin) return

    /*
     * Оболочка отдаётся из сети, а кэш — запасной аэродром. Наоборот
     * (сначала кэш) быстрее, но тогда человек после обновления сайта
     * продолжает сидеть на старой версии до перезапуска приложения,
     * и на вопрос «почему у меня не работает» ответить нечем.
     */
    event.respondWith((async () => {
        try {
            const fresh = await fetch(req)
            if (fresh && fresh.ok) {
                const cache = await caches.open(VERSION)
                cache.put(req, fresh.clone())
            }
            return fresh
        } catch {
            const hit = await caches.match(req)
            if (hit) return hit
            // Переход по адресу без сети — отдаём хоть что-то осмысленное
            if (req.mode === "navigate") {
                const shell = await caches.match("app.html")
                if (shell) return shell
            }
            throw new Error("offline")
        }
    })())
})

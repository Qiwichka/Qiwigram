/*
 * voice.js — запись голосовых сообщений.
 *
 * Запись идёт встроенным MediaRecorder, без единой библиотеки и без единого
 * платного сервиса: браузер сам сжимает звук в opus, дальше файл шифруется
 * и уезжает в то же хранилище, что и фотографии.
 *
 * Формат выбирается из того, что поддерживает конкретный браузер: Chrome и
 * Firefox дают webm/opus, Safari — mp4/aac. Жёстко назвать один нельзя,
 * запись просто не запустится.
 */

const CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    ""
]

function pickMime() {
    if (typeof MediaRecorder === "undefined") return null
    for (const type of CANDIDATES) {
        if (type === "" || MediaRecorder.isTypeSupported(type)) return type
    }
    return null
}

export function voiceSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && pickMime() !== null
}

/**
 * Начать запись. Возвращает объект с stop() и cancel().
 * onTick получает длительность в секундах — для бегущего счётчика.
 */
export async function startRecording(onTick) {
    const mime = pickMime()
    if (mime === null) throw new Error("Браузер не умеет записывать звук")

    let stream
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                // без этого в записи слышно эхо собственных колонок и фон
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        })
    } catch (e) {
        if (e && e.name === "NotAllowedError") {
            throw new Error("Нет доступа к микрофону — разреши его в настройках браузера")
        }
        throw new Error("Микрофон недоступен")
    }

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const parts = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data) }
    rec.start()

    const startedAt = Date.now()
    const timer = setInterval(() => {
        if (onTick) onTick((Date.now() - startedAt) / 1000)
    }, 200)

    // Дорожку микрофона надо гасить руками: иначе в панели браузера
    // остаётся висеть красная точка «идёт запись», даже когда всё кончилось
    const shutdown = () => {
        clearInterval(timer)
        stream.getTracks().forEach((t) => t.stop())
    }

    return {
        get seconds() { return (Date.now() - startedAt) / 1000 },

        stop() {
            return new Promise((resolve) => {
                rec.onstop = () => {
                    shutdown()
                    const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" })
                    resolve({
                        blob,
                        seconds: Math.round((Date.now() - startedAt) / 1000),
                        mime: rec.mimeType || "audio/webm"
                    })
                }
                rec.stop()
            })
        },

        cancel() {
            try { rec.stop() } catch { /* уже остановлен */ }
            shutdown()
        }
    }
}

/** Секунды -> «0:07». */
export function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec))
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
}

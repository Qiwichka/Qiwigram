/* ui.js — мелочи, из которых собран интерфейс */

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

/** Создать элемент. attrs со значением null/false просто не ставятся. */
export function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue
        if (k === "class") node.className = v
        else if (k === "html") node.innerHTML = v
        else if (k === "text") node.textContent = v
        else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v)
        else node.setAttribute(k, v === true ? "" : v)
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue
        node.append(kid.nodeType ? kid : document.createTextNode(kid))
    }
    return node
}

export function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
}

/*
 * Ссылки в тексте сообщения. Собираем разметку строкой, поэтому ВЕСЬ текст
 * сначала экранируется, и только потом в него вставляются теги <a> — иначе
 * любой желающий пришлёт «<img onerror=...>» и выполнит свой скрипт в чужом
 * браузере. Проверка href нужна отдельно: «javascript:...» тоже ссылка.
 */
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi

export function linkify(text) {
    return escapeHtml(text).replace(URL_RE, (m) => {
        const href = m.toLowerCase().startsWith("http") ? m : "https://" + m
        let safe
        try {
            const u = new URL(href)
            if (u.protocol !== "http:" && u.protocol !== "https:") return m
            safe = u.href
        } catch {
            return m
        }
        return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow">${m}</a>`
    })
}

/* ------------------------------- аватарки ------------------------------- */

const AVATAR_COLORS = [
    "#e17076", "#7bc862", "#e5ca77", "#65aadd",
    "#a695e7", "#ee7aae", "#6ec9cb", "#faa774"
]

/** Цвет кружка выводится из ника, чтобы не менялся между запусками. */
export function avatarColor(seed) {
    let h = 0
    const s = String(seed || "?")
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2)
    return parts.map((p) => p[0] || "").join("").toUpperCase() || "?"
}

export function avatarNode(name, url, extraClass = "", online = false) {
    const node = el("div", { class: "avatar " + extraClass })
    if (url) {
        node.append(el("img", { src: url, alt: "", loading: "lazy" }))
    } else {
        node.style.background = avatarColor(name)
        node.textContent = initials(name)
    }
    if (online) node.append(el("i", { class: "avatar__dot", title: "в сети" }))
    return node
}

/* «В сети» — то же пороговое значение, что и у надписи в шапке чата:
   присутствие отмечается раз в минуту, так что полторы минуты запаса
   не дают точке мигать у того, кто просто сидит и читает. */
export function isOnline(lastSeen) {
    return !!lastSeen && (Date.now() - new Date(lastSeen)) < 90_000
}

/* --------------------------------- время --------------------------------- */

const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"]
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
                "июля", "августа", "сентября", "октября", "ноября", "декабря"]

export function fmtTime(d) {
    return new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
}

/** Метка для строки в списке чатов: сегодня — часы, эта неделя — день, дальше — дата. */
export function fmtListTime(d) {
    const date = new Date(d)
    const now = new Date()
    const sameDay = date.toDateString() === now.toDateString()
    if (sameDay) return fmtTime(date)
    const diff = (now - date) / 86400000
    if (diff < 7) return DAYS[date.getDay()].slice(0, 2)
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "2-digit", year: "2-digit" })
}

/** Разделитель дня внутри переписки. */
export function fmtDay(d) {
    const date = new Date(d)
    const now = new Date()
    const today = now.toDateString()
    const yday = new Date(now.getTime() - 86400000).toDateString()
    if (date.toDateString() === today) return "Сегодня"
    if (date.toDateString() === yday) return "Вчера"
    const y = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ""
    return `${date.getDate()} ${MONTHS[date.getMonth()]}${y}`
}

export function fmtLastSeen(d) {
    if (!d) return "давно не заходил"
    const diff = (Date.now() - new Date(d)) / 1000
    if (diff < 90) return "в сети"
    if (diff < 3600) return `был ${Math.floor(diff / 60)} мин назад`
    if (diff < 86400) return `был ${Math.floor(diff / 3600)} ч назад`
    return "был " + new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })
}

export function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100
    if (m10 === 1 && m100 !== 11) return one
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
    return many
}

/* ------------------------------ уведомления ------------------------------ */

export function toast(text, bad = false) {
    const box = $("#toasts")
    if (!box) return
    const node = el("div", { class: "toast" + (bad ? " toast--bad" : ""), text })
    box.append(node)
    setTimeout(() => {
        node.style.transition = "opacity .25s"
        node.style.opacity = "0"
        setTimeout(() => node.remove(), 260)
    }, bad ? 4200 : 2600)
}

/* --------------------------------- окна --------------------------------- */

let modalCloser = null

/**
 * Показать окно. build получает узел .modal и функцию закрытия.
 * Возвращает промис, который разрешается тем, что передали в close().
 */
export function modal(build) {
    const scrim = $("#modal-scrim")
    const box = $("#modal")
    box.innerHTML = ""

    return new Promise((resolve) => {
        const close = (value) => {
            if (modalCloser !== close) return
            modalCloser = null
            scrim.hidden = true
            box.innerHTML = ""
            document.removeEventListener("keydown", onKey)
            scrim.removeEventListener("mousedown", onScrim)
            resolve(value)
        }
        const onKey = (e) => { if (e.key === "Escape") close(null) }
        // именно mousedown и именно по самой подложке: закрывать окно из-за
        // того, что выделение текста внутри закончилось снаружи, нельзя
        const onScrim = (e) => { if (e.target === scrim) close(null) }

        modalCloser = close
        document.addEventListener("keydown", onKey)
        scrim.addEventListener("mousedown", onScrim)
        scrim.hidden = false
        build(box, close)

        const first = box.querySelector("input, textarea, button")
        if (first) setTimeout(() => first.focus(), 40)
    })
}

export function confirmBox({ title, text, ok = "Да", danger = false }) {
    return modal((box, close) => {
        box.append(
            el("h2", { text: title }),
            text ? el("p", { class: "modal__sub", text }) : null,
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(false) }, "Отмена"),
                el("button", {
                    class: "btn btn--primary",
                    style: danger ? "background:var(--danger)" : null,
                    onclick: () => close(true)
                }, ok)
            )
        )
    })
}

/* ------------------------------- медиа ------------------------------- */

export function openViewer(node) {
    const viewer = $("#viewer")
    const stage = $("#viewer-stage")
    stage.innerHTML = ""
    stage.append(node)
    viewer.hidden = false

    const close = () => {
        viewer.hidden = true
        viewer.style.opacity = ""
        stage.style.transform = ""
        stage.classList.remove("is-dragging")
        stage.innerHTML = ""
        viewerCloser = null
        document.removeEventListener("keydown", onKey)
    }
    const onKey = (e) => { if (e.key === "Escape") close() }
    document.addEventListener("keydown", onKey)
    $("#viewer-close").onclick = close
    viewer.onclick = (e) => { if (e.target === viewer || e.target === stage) close() }

    viewerCloser = close
    wireViewerSwipe()
}

/*
 * Закрытие просмотра движением вниз.
 *
 * На телефоне крестик уезжает под самый верх экрана, а картинку разглядывают,
 * держа телефон одной рукой. Смахивание вниз — то, что здесь пробуют первым,
 * и оно должно работать. Картинка едет за пальцем и по дороге гаснет фон:
 * так видно, что жест засчитан, ещё до того как палец отпустили.
 */
let viewerCloser = null
let viewerSwipeWired = false

function wireViewerSwipe() {
    // просмотрщик в разметке один и тот же, обработчики нужны тоже одни:
    // вешать их на каждое открытие значит копить их до конца сеанса
    if (viewerSwipeWired) return
    viewerSwipeWired = true

    const viewer = $("#viewer")
    const stage = $("#viewer-stage")
    if (!viewer || !stage) return

    const TRIGGER = 110

    let axis = null
    let x0 = 0, y0 = 0, dy = 0

    const start = (e) => {
        if (e.touches.length !== 1) return
        axis = null
        x0 = e.touches[0].clientX
        y0 = e.touches[0].clientY
        dy = 0
    }

    const move = (e) => {
        if (e.touches.length !== 1) return
        const mx = e.touches[0].clientX - x0
        const my = e.touches[0].clientY - y0

        if (axis === null) {
            if (Math.abs(mx) < 10 && Math.abs(my) < 10) return
            axis = Math.abs(my) > Math.abs(mx) ? "y" : "x"
            if (axis === "y") stage.classList.add("is-dragging")
        }
        if (axis !== "y") return

        dy = my
        stage.style.transform = `translateY(${dy}px) scale(${Math.max(0.82, 1 - Math.abs(dy) / 1400)})`
        viewer.style.opacity = String(Math.max(0.35, 1 - Math.abs(dy) / 520))
    }

    const release = () => {
        if (axis === "y") {
            stage.classList.remove("is-dragging")
            if (Math.abs(dy) >= TRIGGER && viewerCloser) {
                axis = null
                dy = 0
                return viewerCloser()
            }
            stage.style.transform = ""
            viewer.style.opacity = ""
        }
        axis = null
        dy = 0
    }

    viewer.addEventListener("touchstart", start, { passive: true })
    viewer.addEventListener("touchmove", move, { passive: true })
    viewer.addEventListener("touchend", release)
    viewer.addEventListener("touchcancel", release)
}

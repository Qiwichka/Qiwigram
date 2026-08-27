/* app.js — сборка мессенджера */

import * as db from "./db.js"
import {
    $, $$, el, linkify, escapeHtml, avatarNode, avatarColor, initials,
    fmtTime, fmtListTime, fmtDay, fmtLastSeen, plural,
    toast, modal, confirmBox, openViewer
} from "./ui.js"

const CFG = window.QIWI
const isTouch = window.matchMedia("(pointer: coarse)").matches

/* ============================================================================
   СОСТОЯНИЕ
   ============================================================================ */

const S = {
    me: null,
    chats: [],
    chat: null,          // строка из chat_overview для открытого чата
    messages: [],
    unsubChat: null,
    unsubInbox: null,
    typing: null,
    typingWho: new Map(),
    replyTo: null,
    attach: [],          // { file, kind, url, spoiler }
    spoilerOn: false,
    viewOnce: false,
    loadingTop: false,
    reachedTop: false,
    editing: null
}

/* ============================================================================
   ЗАПУСК
   ============================================================================ */

boot().catch((e) => {
    // Иначе сорванный запуск выглядит как вечно ползущая полоска
    console.error(e)
    if (window.qiwiBootError) window.qiwiBootError("Сбой при запуске:\n" + (e.message || e))
})

/* Именно объявлением функции, а не стрелкой в const: boot() вызывается выше
   по файлу, а объявления поднимаются, тогда как const — нет. */
function step(s) {
    if (window.qiwiStep) window.qiwiStep(s)
}

async function boot() {
    step("модули загружены")
    applyThemeChips()

    // Регистрация нужна и здесь, а не только на главной: в APK человек
    // открывает сразу app.html и на index.html может не зайти никогда
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(() => { /* не критично */ })
    }

    step("читаю сессию")
    const session = await db.currentSession()
    step("сессия: " + (session ? "есть" : "нет"))
    if (!session) return showAuth()

    step("читаю профиль")
    S.me = await db.myProfile()
    if (!S.me) {
        // сессия жива, а профиля нет — такое бывает, если регистрацию
        // оборвало на полпути; проще выйти и начать заново
        await db.logout()
        return showAuth()
    }
    await startApp()
}

function showAuth() {
    step("показываю форму входа")
    $("#boot").hidden = true
    $("#auth").hidden = false
    wireAuth()
}

async function startApp() {
    $("#boot").hidden = true
    $("#auth").hidden = true
    $("#app").hidden = false

    wireApp()
    renderMe()
    await refreshChats()

    S.unsubInbox = db.watchInbox(() => scheduleChatsRefresh())

    db.touchPresence()
    setInterval(db.touchPresence, 60_000)

    // Ссылка вида app.html#@kiwi или #join=<id>:<code> открывает чат сразу
    handleHash()
    window.addEventListener("hashchange", handleHash)
}

/* ============================================================================
   ВХОД И РЕГИСТРАЦИЯ
   ============================================================================ */

function wireAuth() {
    const tabs = $$(".auth__tab")
    const forms = { login: $("#form-login"), register: $("#form-register") }

    tabs.forEach((tab) => {
        tab.onclick = () => {
            tabs.forEach((t) => t.classList.toggle("is-active", t === tab))
            for (const [name, form] of Object.entries(forms)) {
                form.hidden = name !== tab.dataset.tab
            }
        }
    })

    /* --------------------------- проверка ника --------------------------- */

    const regForm = forms.register
    const hint = $("[data-username-hint]", regForm)
    let checkTimer = 0

    regForm.username.addEventListener("input", () => {
        const name = regForm.username.value.trim()
        clearTimeout(checkTimer)
        hint.className = "field__hint"

        if (!name) {
            hint.textContent = "Латиница, цифры и подчёркивание, от 3 до 32 символов"
            return
        }
        if (!CFG.USERNAME_RE.test(name)) {
            hint.textContent = "Только латиница, цифры и подчёркивание, от 3 до 32 символов"
            hint.classList.add("is-bad")
            return
        }

        hint.textContent = "Проверяю…"
        // ждём паузы в наборе: иначе на каждый символ уходит запрос
        checkTimer = setTimeout(async () => {
            const free = await db.usernameFree(name)
            hint.textContent = free ? `@${name} свободен` : `@${name} уже занят`
            hint.classList.add(free ? "is-good" : "is-bad")
        }, 400)
    })

    /* ------------------------------ отправка ------------------------------ */

    const submit = async (form, action) => {
        const err = $("[data-error]", form)
        const btn = $("button[type=submit]", form)
        err.hidden = true
        btn.disabled = true
        const label = btn.textContent
        btn.textContent = "Секунду…"

        try {
            await action()
            S.me = await db.myProfile()
            if (!S.me) throw new Error("Профиль не создался, попробуй ещё раз")
            $("#auth").hidden = true
            await startApp()
        } catch (e) {
            err.textContent = e.message
            err.hidden = false
        } finally {
            btn.disabled = false
            btn.textContent = label
        }
    }

    forms.login.onsubmit = (e) => {
        e.preventDefault()
        const f = e.target
        submit(f, () => db.login({
            username: f.username.value.trim(),
            password: f.password.value
        }))
    }

    forms.register.onsubmit = (e) => {
        e.preventDefault()
        const f = e.target
        submit(f, () => db.register({
            username: f.username.value.trim(),
            password: f.password.value,
            email: f.email.value.trim()
        }))
    }
}

/* ============================================================================
   КАРКАС ПРИЛОЖЕНИЯ
   ============================================================================ */

function wireApp() {
    $("#btn-menu").onclick = openDrawer
    $("#drawer-scrim").onclick = closeDrawer
    $("#btn-back").onclick = closeChat
    $("#btn-new").onclick = () => openNewChatMenu()
    $("#btn-new-group").onclick = () => { closeDrawer(); createChatDialog("group") }
    $("#btn-new-channel").onclick = () => { closeDrawer(); createChatDialog("channel") }
    $("#btn-edit-profile").onclick = () => { closeDrawer(); editProfileDialog() }
    $("#btn-logout").onclick = async () => {
        closeDrawer()
        if (!(await confirmBox({ title: "Выйти из аккаунта?", ok: "Выйти", danger: true }))) return
        await db.logout()
        location.reload()
    }
    $("#btn-chat-info").onclick = () => S.chat && chatInfoDialog()

    $$("[data-theme-set]").forEach((chip) => {
        chip.onclick = () => setTheme(chip.dataset.themeSet)
    })

    wireSearch()
    wireComposer()

    // Аппаратная кнопка «назад» в Android-обёртке должна закрывать чат,
    // а не выбрасывать из приложения
    window.addEventListener("popstate", () => {
        if ($("#viewer").hidden === false) return
        if (S.chat) closeChat()
    })
}

/* --------------------------------- темы --------------------------------- */

function setTheme(name) {
    document.documentElement.setAttribute("data-theme", name)
    try { localStorage.setItem("qiwi.theme", name) } catch { /* приватный режим */ }

    // Цвет системной панели в PWA берётся отсюда
    const bg = getComputedStyle(document.body).backgroundColor
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = bg

    applyThemeChips()
}

function applyThemeChips() {
    const cur = document.documentElement.getAttribute("data-theme") || "dark"
    $$("[data-theme-set]").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.themeSet === cur)
    })
}

/* -------------------------------- шторка -------------------------------- */

function openDrawer() {
    $("#drawer").hidden = false
    $("#drawer-scrim").hidden = false
}
function closeDrawer() {
    $("#drawer").hidden = true
    $("#drawer-scrim").hidden = true
}

function renderMe() {
    const fresh = avatarNode(S.me.display_name || S.me.username, S.me.avatar_url, "avatar--lg")
    // id обязан переехать на новый узел: без него следующая перерисовка
    // профиля не найдёт, что менять
    fresh.id = "me-avatar"
    $("#me-avatar").replaceWith(fresh)
    $("#me-name").textContent = S.me.display_name || S.me.username
    $("#me-username").textContent = "@" + S.me.username
}

/* ============================================================================
   СПИСОК ЧАТОВ
   ============================================================================ */

let refreshTimer = 0

/* Обновления прилетают пачками (пришло сообщение, поменялось членство,
   сгорело просроченное). Перерисовывать список на каждое — значит дёргать
   базу десятки раз в секунду, поэтому события сливаются в один вызов. */
function scheduleChatsRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refreshChats, 260)
}

async function refreshChats() {
    try {
        S.chats = await db.chatOverview()
    } catch (e) {
        toast(e.message, true)
        return
    }
    renderChatList()

    if (S.chat) {
        const fresh = S.chats.find((c) => c.chat_id === S.chat.chat_id)
        if (fresh) {
            S.chat = fresh
            renderChatHeader()
        }
    }
}

function renderChatList() {
    const list = $("#chat-list")
    list.innerHTML = ""

    if (!S.chats.length) {
        list.append(el("div", {
            class: "chat__empty-badge",
            style: "margin:26px auto;display:table"
        }, "Пока пусто. Жми + и найди кого-нибудь"))
        return
    }

    for (const c of S.chats) {
        list.append(chatRow(c))
    }
}

function chatTitle(c) {
    if (c.type === "dm") return c.peer_name || c.peer_username || "Диалог"
    return c.title || "Без названия"
}

function chatRow(c) {
    const title = chatTitle(c)
    const active = S.chat && S.chat.chat_id === c.chat_id

    let preview = ""
    if (c.last_has_media) preview = "📷 Медиа"
    else if (c.last_body) preview = c.last_body
    else preview = "Нет сообщений"

    // В группе и канале полезно видеть, кто написал
    if (c.type !== "dm" && c.last_sender_name && c.last_body) {
        preview = (c.last_sender_id === S.me.id ? "Вы" : c.last_sender_name) + ": " + preview
    }

    const row = el("button", { class: "row" + (active ? " is-active" : "") },
        avatarNode(title, c.avatar_url),
        el("div", { class: "row__body" },
            el("div", { class: "row__top" },
                el("div", { class: "row__name" },
                    (c.type === "channel" ? "📢 " : c.type === "group" ? "👥 " : "") + title),
                el("div", { class: "row__time", text: c.last_message_at ? fmtListTime(c.last_message_at) : "" })
            ),
            el("div", { class: "row__bottom" },
                el("div", { class: "row__preview", text: preview }),
                c.ttl_seconds ? el("span", { class: "row__time", title: "Таймер включён" }, "⏱") : null,
                c.unread > 0 ? el("span", { class: "row__badge", text: c.unread > 99 ? "99+" : String(c.unread) }) : null
            )
        )
    )
    row.onclick = () => openChat(c.chat_id)
    return row
}

/* ============================================================================
   ПОИСК
   ============================================================================ */

function wireSearch() {
    const input = $("#search")
    const box = $("#search-results")
    let timer = 0

    const hide = () => { box.hidden = true; box.innerHTML = "" }

    input.addEventListener("input", () => {
        const q = input.value.trim().replace(/^@/, "")
        clearTimeout(timer)
        if (!q) return hide()

        timer = setTimeout(async () => {
            box.hidden = false
            box.innerHTML = ""
            box.append(el("div", { class: "chat__empty-badge", style: "margin:20px auto;display:table" }, "Ищу…"))

            const [users, chats] = await Promise.all([
                db.searchUsers(q).catch(() => []),
                db.publicChats(q).catch(() => [])
            ])

            box.innerHTML = ""
            if (!users.length && !chats.length) {
                box.append(el("div", { class: "chat__empty-badge", style: "margin:20px auto;display:table" },
                    "Никого не нашлось"))
                return
            }

            for (const u of users) {
                const row = el("button", { class: "row" },
                    avatarNode(u.display_name || u.username, u.avatar_url),
                    el("div", { class: "row__body" },
                        el("div", { class: "row__name", text: u.display_name || u.username }),
                        el("div", { class: "row__preview", text: "@" + u.username })
                    )
                )
                row.onclick = async () => {
                    try {
                        const id = await db.startDm(u.id)
                        input.value = ""
                        hide()
                        await refreshChats()
                        openChat(id)
                    } catch (e) { toast(e.message, true) }
                }
                box.append(row)
            }

            for (const c of chats) {
                const row = el("button", { class: "row" },
                    avatarNode(c.title || c.username, c.avatar_url),
                    el("div", { class: "row__body" },
                        el("div", { class: "row__name", text: (c.type === "channel" ? "📢 " : "👥 ") + (c.title || c.username) }),
                        el("div", { class: "row__preview", text: "@" + c.username })
                    )
                )
                row.onclick = async () => {
                    try {
                        await db.joinChat(c.id)
                        input.value = ""
                        hide()
                        await refreshChats()
                        openChat(c.id)
                    } catch (e) { toast(e.message, true) }
                }
                box.append(row)
            }
        }, 300)
    })

    input.addEventListener("blur", () => setTimeout(hide, 180))
}

/* ============================================================================
   ОТКРЫТИЕ ЧАТА
   ============================================================================ */

async function openChat(chatId) {
    if (S.unsubChat) { S.unsubChat(); S.unsubChat = null }
    if (S.typing) { S.typing.stop(); S.typing = null }

    let row = S.chats.find((c) => c.chat_id === chatId)
    if (!row) {
        await refreshChats()
        row = S.chats.find((c) => c.chat_id === chatId)
    }
    if (!row) { toast("Чат недоступен", true); return }

    S.chat = row
    S.messages = []
    S.replyTo = null
    S.reachedTop = false
    S.attach = []
    S.editing = null
    renderAttach()
    renderReplyBar()

    $("#chat-empty").hidden = true
    $("#chat-inner").hidden = false
    $("#app").classList.add("is-chat-open")
    renderChatHeader()
    renderChatList()

    // чтобы аппаратная «назад» вернула в список, а не вышла из приложения
    if (isTouch) history.pushState({ chat: chatId }, "")

    const list = $("#messages-list")
    list.innerHTML = ""
    $("#messages-top").innerHTML = '<div class="spinner"></div>'

    try {
        S.messages = await db.loadMessages(chatId)
    } catch (e) {
        toast(e.message, true)
    }
    $("#messages-top").innerHTML = ""
    if (S.messages.length < CFG.PAGE_SIZE) S.reachedTop = true

    renderMessages()
    scrollToBottom(false)
    db.markRead(chatId).then(scheduleChatsRefresh)

    S.unsubChat = db.watchChat(chatId, {
        insert: onIncoming,
        update: onUpdated,
        remove: (old) => removeMessage(old.id)
    })
    S.typing = db.typingChannel(chatId, S.me, onTyping)

    // Канал без права писать — поле ввода прячем
    const canPost = S.chat.type !== "channel" || ["owner", "admin"].includes(S.chat.my_role)
    $("#composer").style.display = canPost ? "" : "none"

    // В группе у каждого сообщения подписан автор, а имена приходят
    // отдельным запросом — не ждём его, лента дорисует подписи сама
    if (row.type !== "dm") primePeople(chatId)

    wireMessagesScroll()
}

function closeChat() {
    if (S.unsubChat) { S.unsubChat(); S.unsubChat = null }
    if (S.typing) { S.typing.stop(); S.typing = null }
    S.chat = null
    $("#app").classList.remove("is-chat-open")
    $("#chat-inner").hidden = true
    $("#chat-empty").hidden = false
    renderChatList()
}

function renderChatHeader() {
    const c = S.chat
    if (!c) return
    const title = chatTitle(c)

    $("#chat-avatar").replaceWith(
        Object.assign(avatarNode(title, c.avatar_url), { id: "chat-avatar" })
    )
    $("#chat-name").textContent = title

    let status
    if (c.type === "dm") status = fmtLastSeen(c.peer_last_seen)
    else if (c.type === "channel") status = c.username ? "@" + c.username : "канал"
    else status = c.username ? "@" + c.username : "группа"

    if (c.ttl_seconds) status += " · ⏱ " + ttlLabel(c.ttl_seconds)
    $("#chat-status").textContent = status
}

/* ============================================================================
   ЛЕНТА СООБЩЕНИЙ
   ============================================================================ */

function wireMessagesScroll() {
    const box = $("#messages")
    box.onscroll = async () => {
        if (box.scrollTop > 120 || S.loadingTop || S.reachedTop || !S.messages.length) return
        S.loadingTop = true
        $("#messages-top").innerHTML = '<div class="spinner"></div>'

        const before = S.messages[0].created_at
        const prevHeight = box.scrollHeight
        try {
            const older = await db.loadMessages(S.chat.chat_id, before)
            if (older.length < CFG.PAGE_SIZE) S.reachedTop = true
            if (older.length) {
                S.messages = older.concat(S.messages)
                renderMessages()
                // держим взгляд на том же сообщении, а не прыгаем наверх
                box.scrollTop = box.scrollHeight - prevHeight
            }
        } catch (e) {
            toast(e.message, true)
        }
        $("#messages-top").innerHTML = ""
        S.loadingTop = false
    }
}

function renderMessages() {
    const list = $("#messages-list")
    list.innerHTML = ""

    let lastDay = ""
    let prev = null

    S.messages.forEach((m, i) => {
        const day = new Date(m.created_at).toDateString()
        if (day !== lastDay) {
            list.append(el("div", { class: "day", text: fmtDay(m.created_at) }))
            lastDay = day
            prev = null
        }

        const next = S.messages[i + 1]
        // «блок» — подряд идущие сообщения одного человека в пределах пяти
        // минут; у них общий аватар и скруглённый низ только у последнего
        const isFirst = !prev || prev.sender_id !== m.sender_id ||
            new Date(m.created_at) - new Date(prev.created_at) > 300_000
        const isLast = !next || next.sender_id !== m.sender_id ||
            new Date(next.created_at) - new Date(m.created_at) > 300_000 ||
            new Date(next.created_at).toDateString() !== day

        list.append(messageNode(m, { isFirst, isLast }))
        prev = m
    })
}

function messageNode(m, { isFirst, isLast }) {
    const out = m.sender_id === S.me.id
    const author = findName(m.sender_id)

    const node = el("div", {
        class: "msg" + (out ? " msg--out" : "") + (isFirst ? " is-first" : "") + (isLast ? " is-last" : ""),
        "data-id": m.id
    })

    if (!out && S.chat.type !== "dm") {
        node.append(avatarNode(author, null, "avatar--sm msg__avatar"))
    }

    const bubble = el("div", { class: "msg__bubble" })

    if (!out && S.chat.type !== "dm" && isFirst) {
        bubble.append(el("div", { class: "msg__author", text: author }))
    }

    if (m.reply_to) bubble.append(quoteNode(m.reply_to))
    if (m.media && m.media.length) bubble.append(mediaNode(m))

    if (m.body) {
        bubble.append(el("div", { class: "msg__text", html: linkify(m.body) }))
    }

    const meta = el("div", { class: "msg__meta" })
    if (m.edited_at) meta.append(el("span", { class: "msg__edited", text: "изм. " }))
    if (m.expires_at) meta.append(el("span", { text: "⏱ " }))
    meta.append(el("span", { text: fmtTime(m.created_at) }))
    bubble.append(meta)

    node.append(bubble)

    /* Меню сообщения: правая кнопка на компьютере, долгое нажатие на телефоне.
       Ровно одно из двух — Android на удержании присылает и своё
       contextmenu, и наш таймер, и меню открывалось бы дважды. */
    if (isTouch) {
        attachLongPress(bubble, () => messageMenu(m))
        bubble.oncontextmenu = (e) => e.preventDefault()
    } else {
        bubble.oncontextmenu = (e) => { e.preventDefault(); messageMenu(m) }
    }

    return node
}

function findName(userId) {
    if (!userId) return "Неизвестный"
    if (userId === S.me.id) return S.me.display_name || S.me.username
    if (S.chat && S.chat.type === "dm") return S.chat.peer_name || S.chat.peer_username
    const cached = peopleCache.get(userId)
    return cached || "Участник"
}

// Имена участников групп подтягиваются один раз на чат и живут здесь
const peopleCache = new Map()

async function primePeople(chatId) {
    try {
        const people = await db.chatPeople(chatId)
        people.forEach((p) => peopleCache.set(p.id, p.display_name || p.username))
        if (S.chat && S.chat.chat_id === chatId) renderMessages()
    } catch { /* не критично */ }
}

function quoteNode(replyId) {
    const src = S.messages.find((x) => x.id === replyId)
    const quote = el("div", { class: "quote" },
        el("div", { class: "quote__name", text: src ? findName(src.sender_id) : "Сообщение" }),
        el("div", { class: "quote__text", text: src ? (src.body || "📷 Медиа") : "недоступно" })
    )
    quote.onclick = (e) => {
        e.stopPropagation()
        const target = $(`.msg[data-id="${replyId}"]`)
        if (!target) return
        target.scrollIntoView({ block: "center", behavior: "smooth" })
        target.animate(
            [{ background: "var(--accent-soft)" }, { background: "transparent" }],
            { duration: 900 }
        )
    }
    return quote
}

/* --------------------------------- медиа --------------------------------- */

function mediaNode(m) {
    const items = m.media || []
    const box = el("div", { class: `media media--${Math.min(items.length, 4)}` })

    items.forEach((item) => {
        const url = db.mediaUrl(item.path)
        const cell = el("div", { class: "media__item" + (item.spoiler ? " is-spoiler" : "") })

        if (item.type === "video") {
            cell.append(el("video", { src: url, preload: "metadata", playsinline: true, muted: true }))
            cell.append(el("div", { class: "media__play" },
                el("span", { html: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>' })))
        } else {
            cell.append(el("img", { src: url, alt: "", loading: "lazy" }))
        }

        if (item.spoiler) cell.append(el("div", { class: "media__hint", text: "Нажми, чтобы открыть" }))
        if (m.view_once) cell.append(el("div", { class: "media__once", text: "1 РАЗ" }))

        cell.onclick = async (e) => {
            e.stopPropagation()
            // первое нажатие по спойлеру только снимает размытие
            if (cell.classList.contains("is-spoiler")) {
                cell.classList.remove("is-spoiler")
                return
            }
            if (m.view_once && m.sender_id !== S.me.id) {
                const ok = await confirmBox({
                    title: "Открыть один раз?",
                    text: "После просмотра вложение исчезнет у всех и вернуть его будет нельзя.",
                    ok: "Открыть"
                })
                if (!ok) return
                showFullMedia(item, url)
                try { await db.burnMessage(m.id) } catch { /* уже сгорело */ }
                return
            }
            showFullMedia(item, url)
        }

        box.append(cell)
    })

    if (m.view_once && !items.length) {
        box.append(el("div", { class: "media__burnt" }, el("span", { text: "🔥" }), el("span", { text: "Вложение сгорело" })))
    }

    return box
}

function showFullMedia(item, url) {
    const node = item.type === "video"
        ? el("video", { src: url, controls: true, autoplay: true, playsinline: true })
        : el("img", { src: url, alt: "" })
    openViewer(node)
}

/* ------------------------- нажатие с удержанием ------------------------- */

function attachLongPress(node, run) {
    let timer = 0
    let startX = 0, startY = 0

    const cancel = () => clearTimeout(timer)

    node.addEventListener("touchstart", (e) => {
        startX = e.touches[0].clientX
        startY = e.touches[0].clientY
        timer = setTimeout(() => {
            if (navigator.vibrate) navigator.vibrate(12)
            run()
        }, 480)
    }, { passive: true })

    // прокрутка не должна считаться удержанием
    node.addEventListener("touchmove", (e) => {
        const dx = Math.abs(e.touches[0].clientX - startX)
        const dy = Math.abs(e.touches[0].clientY - startY)
        if (dx > 10 || dy > 10) cancel()
    }, { passive: true })

    node.addEventListener("touchend", cancel)
    node.addEventListener("touchcancel", cancel)
}

/* ----------------------------- меню сообщения ----------------------------- */

async function messageMenu(m) {
    const mine = m.sender_id === S.me.id
    const admin = ["owner", "admin"].includes(S.chat.my_role)

    const choice = await modal((box, close) => {
        box.append(
            el("h2", { text: "Сообщение" }),
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("reply") }, "↩︎  Ответить"),
                m.body ? el("button", { class: "opt", onclick: () => close("copy") }, "⧉  Скопировать текст") : null,
                mine && m.body ? el("button", { class: "opt", onclick: () => close("edit") }, "✎  Изменить") : null,
                (mine || admin) ? el("button", {
                    class: "opt", style: "color:var(--danger)", onclick: () => close("delete")
                }, "🗑  Удалить") : null
            )
        )
    })

    if (choice === "reply") {
        S.replyTo = m
        renderReplyBar()
        $("#input").focus()
    } else if (choice === "copy") {
        try {
            await navigator.clipboard.writeText(m.body)
            toast("Скопировано")
        } catch { toast("Не вышло скопировать", true) }
    } else if (choice === "edit") {
        S.editing = m
        const input = $("#input")
        input.textContent = m.body
        input.focus()
        renderReplyBar()
    } else if (choice === "delete") {
        if (!(await confirmBox({ title: "Удалить сообщение?", ok: "Удалить", danger: true }))) return
        try {
            await db.deleteMessage(m.id)
            removeMessage(m.id)
        } catch (e) { toast(e.message, true) }
    }
}

/* ============================================================================
   ВХОДЯЩИЕ
   ============================================================================ */

function onIncoming(row) {
    if (!S.chat || row.chat_id !== S.chat.chat_id) return
    if (S.messages.some((x) => x.id === row.id)) return

    const box = $("#messages")
    // если человек читает старое, дёргать его вниз нельзя
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140

    S.messages.push(row)
    renderMessages()
    if (atBottom) scrollToBottom(true)

    db.markRead(S.chat.chat_id)
    if (row.sender_id !== S.me.id) S.typingWho.delete(row.sender_id)
    renderTyping()
}

function onUpdated(row) {
    const i = S.messages.findIndex((x) => x.id === row.id)
    if (i < 0) return
    if (row.deleted) return removeMessage(row.id)
    S.messages[i] = row
    renderMessages()
}

function removeMessage(id) {
    const i = S.messages.findIndex((x) => x.id === id)
    if (i < 0) return
    S.messages.splice(i, 1)
    renderMessages()
}

function scrollToBottom(smooth) {
    const box = $("#messages")
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" })
}

/* ------------------------------- печатает ------------------------------- */

function onTyping(payload) {
    if (!payload || payload.id === S.me.id) return
    S.typingWho.set(payload.id, { name: payload.name, at: Date.now() })
    renderTyping()
    setTimeout(renderTyping, 3200)
}

function renderTyping() {
    const now = Date.now()
    for (const [id, v] of S.typingWho) {
        if (now - v.at > 3000) S.typingWho.delete(id)
    }
    if (!S.chat) return

    if (!S.typingWho.size) return renderChatHeader()

    const names = Array.from(S.typingWho.values()).map((v) => v.name)
    $("#chat-status").textContent = S.chat.type === "dm"
        ? "печатает…"
        : names.slice(0, 2).join(", ") + (names.length > 2 ? " и другие" : "") + " печатают…"
}

/* ============================================================================
   ОТПРАВКА
   ============================================================================ */

function wireComposer() {
    const input = $("#input")
    const send = $("#btn-send")

    $("#btn-attach").onclick = () => $("#file-input").click()
    $("#file-input").onchange = (e) => {
        addAttachments(Array.from(e.target.files || []))
        e.target.value = ""
    }

    $("#btn-spoiler").onclick = () => {
        S.spoilerOn = !S.spoilerOn
        $("#btn-spoiler").classList.toggle("is-on", S.spoilerOn)
        S.attach.forEach((a) => { a.spoiler = S.spoilerOn })
        renderAttach()
    }

    $("#btn-once").onclick = () => {
        S.viewOnce = !S.viewOnce
        $("#btn-once").classList.toggle("is-on", S.viewOnce)
        toast(S.viewOnce
            ? "Вложение сгорит после первого просмотра"
            : "Обычная отправка")
    }

    $("#reply-cancel").onclick = () => {
        S.replyTo = null
        S.editing = null
        input.textContent = ""
        renderReplyBar()
    }

    input.addEventListener("input", () => {
        if (S.typing) S.typing.ping()
    })

    input.addEventListener("keydown", (e) => {
        // На компьютере Enter отправляет, Shift+Enter переносит строку.
        // На телефоне наоборот: там Enter — это перенос, а отправка кнопкой.
        if (e.key === "Enter" && !e.shiftKey && !isTouch) {
            e.preventDefault()
            doSend()
        }
    })

    // Вставка из буфера обмена приходит с разметкой: чужие шрифты и цвета
    // в поле ввода не нужны, забираем только текст
    input.addEventListener("paste", (e) => {
        const files = Array.from(e.clipboardData?.files || [])
        if (files.length) {
            e.preventDefault()
            addAttachments(files)
            return
        }
        e.preventDefault()
        const text = e.clipboardData.getData("text/plain")
        document.execCommand("insertText", false, text)
    })

    send.onclick = doSend

    // перетаскивание файлов прямо в окно чата
    const chat = $("#chat")
    chat.addEventListener("dragover", (e) => e.preventDefault())
    chat.addEventListener("drop", (e) => {
        e.preventDefault()
        if (!S.chat) return
        addAttachments(Array.from(e.dataTransfer.files || []))
    })
}

function addAttachments(files) {
    const good = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
    if (!good.length) return toast("Можно только фото и видео", true)

    for (const file of good.slice(0, 10)) {
        S.attach.push({
            file,
            kind: file.type.startsWith("video/") ? "video" : "image",
            url: URL.createObjectURL(file),
            spoiler: S.spoilerOn
        })
    }
    renderAttach()
}

function renderAttach() {
    const box = $("#attach-preview")
    box.innerHTML = ""
    const has = S.attach.length > 0

    box.hidden = !has
    // оба переключателя имеют смысл только когда есть что прикреплять
    $("#btn-spoiler").hidden = !has
    $("#btn-once").hidden = !has

    S.attach.forEach((a, i) => {
        const thumb = el("div", { class: "attach-thumb" + (a.spoiler ? " is-spoiler" : "") })
        thumb.append(a.kind === "video"
            ? el("video", { src: a.url, muted: true, playsinline: true })
            : el("img", { src: a.url, alt: "" }))

        thumb.append(el("button", {
            class: "attach-thumb__x",
            html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
            onclick: () => {
                URL.revokeObjectURL(a.url)
                S.attach.splice(i, 1)
                renderAttach()
            }
        }))

        // нажатие по самой картинке переключает спойлер именно у неё
        thumb.onclick = (e) => {
            if (e.target.closest(".attach-thumb__x")) return
            a.spoiler = !a.spoiler
            renderAttach()
        }

        box.append(thumb)
    })
}

function renderReplyBar() {
    const bar = $("#reply-bar")
    if (S.editing) {
        bar.hidden = false
        $("#reply-name").textContent = "Изменение сообщения"
        $("#reply-text").textContent = S.editing.body || ""
        return
    }
    if (!S.replyTo) { bar.hidden = true; return }
    bar.hidden = false
    $("#reply-name").textContent = findName(S.replyTo.sender_id)
    $("#reply-text").textContent = S.replyTo.body || "📷 Медиа"
}

let sending = false

async function doSend() {
    if (sending || !S.chat) return

    const input = $("#input")
    const body = input.innerText.replace(/ /g, " ").trim()
    const files = S.attach.slice()

    if (!body && !files.length) return

    /* правка существующего сообщения — отдельная ветка */
    if (S.editing) {
        const target = S.editing
        S.editing = null
        input.textContent = ""
        renderReplyBar()
        try {
            const updated = await db.editMessage(target.id, body)
            onUpdated(updated)
        } catch (e) { toast(e.message, true) }
        return
    }

    sending = true
    $("#btn-send").disabled = true

    // Поле чистим сразу: ждать загрузки фотографии, глядя на замерший
    // интерфейс, невыносимо. При ошибке текст вернём обратно.
    input.textContent = ""
    S.attach = []
    const replyTo = S.replyTo ? S.replyTo.id : null
    S.replyTo = null
    // «один раз» и спойлер — свойства одной отправки, а не режим работы:
    // забыть их выключить и случайно сжечь следующее фото слишком легко
    const viewOnce = S.viewOnce
    S.viewOnce = false
    S.spoilerOn = false
    $("#btn-once").classList.remove("is-on")
    $("#btn-spoiler").classList.remove("is-on")
    renderAttach()
    renderReplyBar()

    try {
        let media = []
        if (files.length) {
            toast(files.length === 1 ? "Загружаю…" : `Загружаю ${files.length} ${plural(files.length, "файл", "файла", "файлов")}…`)
            media = await Promise.all(files.map((a) =>
                db.uploadMedia(a.file, { spoiler: a.spoiler })))
            files.forEach((a) => URL.revokeObjectURL(a.url))
        }

        const row = await db.sendMessage({
            chatId: S.chat.chat_id,
            body,
            media,
            replyTo,
            viewOnce
        })

        // Своё сообщение рисуем сами: realtime своё же событие не присылает
        onIncoming(row)
        scrollToBottom(true)
        scheduleChatsRefresh()
    } catch (e) {
        toast(e.message, true)
        input.textContent = body
        S.attach = files
        renderAttach()
    } finally {
        sending = false
        $("#btn-send").disabled = false
    }
}

/* ============================================================================
   ОКНА
   ============================================================================ */

async function openNewChatMenu() {
    const choice = await modal((box, close) => {
        box.append(
            el("h2", { text: "Создать" }),
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("dm") }, "✉️  Написать по нику"),
                el("button", { class: "opt", onclick: () => close("group") }, "👥  Группу"),
                el("button", { class: "opt", onclick: () => close("channel") }, "📢  Канал")
            )
        )
    })
    if (choice === "dm") return findUserDialog()
    if (choice === "group" || choice === "channel") return createChatDialog(choice)
}

async function findUserDialog() {
    const name = await modal((box, close) => {
        const input = el("input", { type: "text", placeholder: "kiwi", autocapitalize: "none", spellcheck: "false" })
        box.append(
            el("h2", { text: "Написать по нику" }),
            el("p", { class: "modal__sub", text: "Введи ник без собачки" }),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Ник" }), input),
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Отмена"),
                el("button", { class: "btn btn--primary", onclick: () => close(input.value.trim()) }, "Открыть")
            )
        )
        input.onkeydown = (e) => { if (e.key === "Enter") close(input.value.trim()) }
    })
    if (!name) return
    await openByUsername(name.replace(/^@/, ""))
}

async function openByUsername(name) {
    try {
        const found = await db.resolveUsername(name)
        if (!found) return toast("Никого с таким ником нет", true)

        if (found.kind === "user") {
            const id = await db.startDm(found.id)
            await refreshChats()
            openChat(id)
        } else {
            await db.joinChat(found.id).catch(() => {})
            await refreshChats()
            openChat(found.id)
        }
    } catch (e) { toast(e.message, true) }
}

async function createChatDialog(type) {
    const isChannel = type === "channel"

    const result = await modal((box, close) => {
        const title = el("input", { type: "text", placeholder: isChannel ? "Название канала" : "Название группы" })
        const uname = el("input", { type: "text", placeholder: "необязательно", autocapitalize: "none", spellcheck: "false" })
        const about = el("input", { type: "text", placeholder: "необязательно" })
        const pub = el("input", { type: "checkbox" })
        const hint = el("span", { class: "field__hint", text: "Латиница, цифры и подчёркивание. Даёт ссылку вида @ник" })

        let timer = 0
        uname.oninput = () => {
            const v = uname.value.trim()
            clearTimeout(timer)
            hint.className = "field__hint"
            if (!v) { hint.textContent = "Латиница, цифры и подчёркивание. Даёт ссылку вида @ник"; return }
            if (!CFG.USERNAME_RE.test(v)) {
                hint.textContent = "Только латиница, цифры и подчёркивание, от 3 до 32 символов"
                hint.classList.add("is-bad")
                return
            }
            hint.textContent = "Проверяю…"
            timer = setTimeout(async () => {
                const free = await db.usernameFree(v)
                hint.textContent = free ? `@${v} свободен` : `@${v} уже занят`
                hint.classList.add(free ? "is-good" : "is-bad")
            }, 400)
        }

        box.append(
            el("h2", { text: isChannel ? "Новый канал" : "Новая группа" }),
            el("p", { class: "modal__sub", text: isChannel
                ? "В канале пишешь только ты и админы, остальные читают."
                : "В группе пишут все участники." }),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Название" }), title),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Публичный ник" }), uname, hint),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Описание" }), about),
            el("label", { class: "switch" },
                el("div", { class: "switch__text" },
                    el("div", { class: "switch__title", text: "Публичный" }),
                    el("div", { class: "switch__hint", text: "Публичный найдут поиском и войдут без приглашения. Закрытый — только по ссылке." })
                ),
                pub, el("span", { class: "switch__box" })
            ),
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Отмена"),
                el("button", {
                    class: "btn btn--primary",
                    onclick: () => {
                        if (!title.value.trim()) return toast("Нужно название", true)
                        close({
                            title: title.value.trim(),
                            username: uname.value.trim(),
                            description: about.value.trim(),
                            isPublic: pub.checked
                        })
                    }
                }, "Создать")
            )
        )
    })

    if (!result) return
    try {
        const id = await db.createChat({ type, ...result })
        await refreshChats()
        openChat(id)
        toast(isChannel ? "Канал создан" : "Группа создана")
    } catch (e) { toast(e.message, true) }
}

/* ------------------------------- о чате ------------------------------- */

const TTL_CHOICES = [
    [0, "Выключен"],
    [3600, "1 час"],
    [86400, "24 часа"],
    [604800, "7 дней"],
    [2592000, "30 дней"]
]

function ttlLabel(sec) {
    const found = TTL_CHOICES.find(([v]) => v === sec)
    return found ? found[1] : Math.round(sec / 3600) + " ч"
}

async function chatInfoDialog() {
    const c = S.chat
    const admin = ["owner", "admin"].includes(c.my_role)
    const people = c.type === "dm" ? [] : await db.chatPeople(c.chat_id).catch(() => [])
    people.forEach((p) => peopleCache.set(p.id, p.display_name || p.username))

    const action = await modal((box, close) => {
        box.append(
            el("h2", { text: chatTitle(c) }),
            c.username ? el("p", { class: "modal__sub", text: "@" + c.username }) : null,
            c.type !== "dm"
                ? el("p", { class: "modal__sub", text: `${people.length} ${plural(people.length, "участник", "участника", "участников")}` })
                : null,
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("ttl") },
                    "⏱  Самоуничтожение: " + (c.ttl_seconds ? ttlLabel(c.ttl_seconds) : "выключено")),
                c.type !== "dm" && !c.is_public
                    ? el("button", { class: "opt", onclick: () => close("invite") }, "🔗  Ссылка-приглашение")
                    : null,
                c.type !== "dm"
                    ? el("button", { class: "opt", onclick: () => close("people") }, "👥  Участники")
                    : null,
                c.type !== "dm"
                    ? el("button", { class: "opt", style: "color:var(--danger)", onclick: () => close("leave") }, "🚪  Выйти")
                    : null,
                (c.my_role === "owner" && c.type !== "dm")
                    ? el("button", { class: "opt", style: "color:var(--danger)", onclick: () => close("delete") }, "🗑  Удалить навсегда")
                    : null
            )
        )
    })

    if (action === "ttl") return ttlDialog()
    if (action === "invite") return inviteDialog()
    if (action === "people") return peopleDialog(people, admin)

    if (action === "leave") {
        if (!(await confirmBox({ title: "Выйти из чата?", ok: "Выйти", danger: true }))) return
        try {
            await db.leaveChat(c.chat_id)
            closeChat()
            await refreshChats()
        } catch (e) { toast(e.message, true) }
    }

    if (action === "delete") {
        if (!(await confirmBox({
            title: "Удалить навсегда?",
            text: "Чат и все сообщения исчезнут у всех участников. Отменить это нельзя.",
            ok: "Удалить", danger: true
        }))) return
        try {
            await db.deleteChat(c.chat_id)
            closeChat()
            await refreshChats()
        } catch (e) { toast(e.message, true) }
    }
}

async function ttlDialog() {
    const c = S.chat
    const picked = await modal((box, close) => {
        box.append(
            el("h2", { text: "Самоуничтожение" }),
            el("p", { class: "modal__sub", text: "Каждое новое сообщение будет стираться само по истечении срока. Уже отправленные не тронет." }),
            el("div", { class: "opt-list" },
                TTL_CHOICES.map(([sec, label]) =>
                    el("button", {
                        class: "opt" + ((c.ttl_seconds || 0) === sec ? " is-active" : ""),
                        onclick: () => close(sec)
                    }, label))
            )
        )
    })
    if (picked == null) return
    try {
        await db.setChatTtl(c.chat_id, picked)
        await refreshChats()
        toast(picked ? "Таймер: " + ttlLabel(picked) : "Таймер выключен")
    } catch (e) { toast(e.message, true) }
}

async function inviteDialog() {
    let full
    try {
        const chat = await db.chatById(S.chat.chat_id)
        full = `${location.origin}${location.pathname}#join=${chat.id}:${chat.invite_code}`
    } catch (e) { return toast(e.message, true) }

    await modal((box, close) => {
        const input = el("input", { type: "text", value: full, readonly: true })
        box.append(
            el("h2", { text: "Ссылка-приглашение" }),
            el("p", { class: "modal__sub", text: "Кто откроет эту ссылку — попадёт в чат. Больше её никак не получить." }),
            el("label", { class: "field" }, input),
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Закрыть"),
                el("button", {
                    class: "btn btn--primary",
                    onclick: async () => {
                        try {
                            await navigator.clipboard.writeText(full)
                            toast("Ссылка скопирована")
                        } catch {
                            input.select()
                            toast("Скопируй вручную", true)
                        }
                    }
                }, "Скопировать")
            )
        )
        input.onclick = () => input.select()
    })
}

async function peopleDialog(people, admin) {
    await modal((box, close) => {
        box.append(el("h2", { text: "Участники" }))
        const list = el("div", { class: "opt-list" })

        people.forEach((p) => {
            const row = el("button", { class: "opt" },
                avatarNode(p.display_name || p.username, p.avatar_url, "avatar--sm"),
                el("span", { style: "flex:1" }, (p.display_name || p.username) +
                    (p.role !== "member" ? ` · ${p.role === "owner" ? "владелец" : "админ"}` : "")),
            )
            row.onclick = async () => {
                if (p.id === S.me.id) return
                close(null)
                try {
                    const id = await db.startDm(p.id)
                    await refreshChats()
                    openChat(id)
                } catch (e) { toast(e.message, true) }
            }
            list.append(row)
        })

        box.append(list,
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Закрыть")))
    })
}

async function editProfileDialog() {
    const result = await modal((box, close) => {
        const name = el("input", { type: "text", value: S.me.display_name || "" })
        const bio = el("input", { type: "text", value: S.me.bio || "", placeholder: "необязательно" })
        box.append(
            el("h2", { text: "Профиль" }),
            el("p", { class: "modal__sub", text: "Ник @" + S.me.username + " изменить нельзя — на него ссылаются другие." }),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Имя" }), name),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "О себе" }), bio),
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Отмена"),
                el("button", {
                    class: "btn btn--primary",
                    onclick: () => close({ display_name: name.value.trim() || S.me.username, bio: bio.value.trim() })
                }, "Сохранить")
            )
        )
    })
    if (!result) return
    try {
        S.me = await db.updateProfile(result)
        renderMe()
        toast("Сохранено")
    } catch (e) { toast(e.message, true) }
}

/* ============================================================================
   ССЫЛКИ
   ============================================================================ */

async function handleHash() {
    const hash = decodeURIComponent(location.hash.slice(1))
    if (!hash) return
    history.replaceState(null, "", location.pathname)

    if (hash.startsWith("join=")) {
        const [id, code] = hash.slice(5).split(":")
        try {
            await db.joinChat(id, code)
            await refreshChats()
            openChat(id)
        } catch (e) { toast(e.message, true) }
        return
    }

    if (hash.startsWith("@")) await openByUsername(hash.slice(1))
}

/* app.js — сборка мессенджера */

import * as db from "./db.js"
import { voiceSupported, startRecording, fmtDuration } from "./voice.js"
import {
    $, $$, el, linkify, escapeHtml, avatarNode, avatarColor, initials, isOnline,
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
    editing: null,
    filter: "all",       // вкладка списка чатов
    unreadFrom: null,    // отметка о прочтении на момент открытия чата
    fresh: new Set(),    // id сообщений, которые надо показать с анимацией
    newWhileAway: 0,     // пришло, пока человек читал старое
    reactions: new Map(),// id сообщения -> [{emoji, n, mine}]
    rec: null,           // идущая запись голосового
    hits: [],            // найденное поиском по переписке
    hitAt: -1
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
    /* Тихая попытка взять ключ с устройства — обычный случай, проходит
       незаметно и мгновенно. */
    step("открываю ключи")
    await db.loadKeys().catch(() => false)

    await startApp()

    /* А вот СПРАШИВАТЬ пароль можно только после того, как приложение уже
       на экране. Диалог лежит ниже заставки по слоям, и заданный раньше
       вопрос человек просто не увидит — останется висеть полоска загрузки,
       а под ней невидимое окно, которое ждёт ответа. */
    if (!db.keysReady()) {
        if (await ensureKeys()) await refreshChats()
    }
}

/*
 * Открыть закрытый ключ.
 *
 * Обычно он лежит на этом устройстве и берётся молча. Пароль спрашиваем
 * только когда взять негде: новое устройство, почищенное хранилище, или
 * аккаунт заведён до появления шифрования и пары ключей у него ещё нет.
 *
 * Отказ не запрещает пользоваться приложением: чаты откроются, но вместо
 * текста будет замок. Запирать человека наглухо из-за этого нельзя.
 */
async function ensureKeys() {
    if (db.keysReady()) return true
    if (await db.loadKeys().catch(() => false)) return true

    const password = await modal((box, close) => {
        const input = el("input", { type: "password", autocomplete: "current-password", placeholder: "••••••••" })
        box.append(
            el("h2", { text: "Пароль для расшифровки" }),
            el("p", { class: "modal__sub", text:
                "Переписка зашифрована ключом, который лежит только у тебя. " +
                "Введи пароль от аккаунта, чтобы его открыть — на сервер он не уходит." }),
            el("label", { class: "field" }, el("span", { class: "field__label", text: "Пароль" }), input),
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Потом"),
                el("button", { class: "btn btn--primary", onclick: () => close(input.value) }, "Открыть")
            )
        )
        input.onkeydown = (e) => { if (e.key === "Enter") close(input.value) }
    })

    if (!password) {
        toast("Переписка останется зашифрованной", true)
        return false
    }

    try {
        await db.loadKeys(password)
        return true
    } catch (e) {
        toast(e.message, true)
        return false
    }
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
        if (!(await confirmBox({
            title: "Выйти из аккаунта?",
            text: "Ключ расшифровки сотрётся с этого устройства. При следующем входе понадобится пароль.",
            ok: "Выйти", danger: true
        }))) return
        db.forgetBlobs()
        await db.logout()
        location.reload()
    }
    $("#btn-chat-info").onclick = () => S.chat && chatInfoDialog()
    $("#btn-to-bottom").onclick = () => {
        S.newWhileAway = 0
        scrollToBottom(true)
        // прокрутка плавная, а кнопка должна погаснуть сразу
        setTimeout(updateToBottom, 350)
    }

    $$("[data-theme-set]").forEach((chip) => {
        chip.onclick = () => setTheme(chip.dataset.themeSet)
    })

    $("#btn-copy-me").onclick = async () => {
        try {
            await navigator.clipboard.writeText("@" + S.me.username)
            toast("Ник скопирован")
        } catch { toast("Не вышло скопировать", true) }
    }

    wireFilters()
    wireSearch()
    wireChatSearch()
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
            const wasRead = S.chat.peer_read_at
            S.chat = fresh
            renderChatHeader()
            // собеседник дочитал — галочки в ленте должны стать двойными
            if (fresh.peer_read_at !== wasRead) renderMessages()
        }
    }
}

/** Какие чаты показывать. Фильтр живёт только в интерфейсе. */
function passesFilter(c) {
    switch (S.filter) {
        case "unread": return c.unread > 0
        case "dm": return c.type === "dm"
        case "groups": return c.type === "group" || c.type === "channel"
        default: return true
    }
}

function emptyState(title, text, action) {
    return el("div", { class: "empty" },
        el("div", { class: "empty__art" },
            el("span", { html: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.9 8.9 0 01-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 1121 11.5z"/></svg>' })),
        el("div", { class: "empty__title", text: title }),
        el("div", { class: "empty__text", text }),
        action || null
    )
}

function renderChatList() {
    const list = $("#chat-list")
    list.innerHTML = ""

    if (!S.chats.length) {
        list.append(emptyState(
            "Здесь пока пусто",
            "Найди кого-нибудь по нику или собери свою группу.",
            el("button", { class: "btn btn--primary", onclick: openNewChatMenu }, "Начать переписку")
        ))
        return
    }

    const shown = S.chats.filter(passesFilter)
    if (!shown.length) {
        list.append(emptyState(
            "Ничего не подходит",
            S.filter === "unread"
                ? "Непрочитанных нет — всё разобрано."
                : "В этой вкладке пока пусто."
        ))
        return
    }

    for (const c of shown) {
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
    // У зашифрованного чата сервер предпросмотра не отдаёт — он его не знает.
    // Наличие сообщения выдаёт только отправитель.
    else if (c.last_sender_id) preview = "🔒 Зашифровано"
    else preview = "Нет сообщений"

    // В группе и канале полезно видеть, кто написал
    if (c.type !== "dm" && c.last_sender_name && c.last_body) {
        preview = (c.last_sender_id === S.me.id ? "Вы" : c.last_sender_name) + ": " + preview
    }

    const row = el("button", { class: "row" + (active ? " is-active" : "") },
        avatarNode(title, c.avatar_url, "", c.type === "dm" && isOnline(c.peer_last_seen)),
        el("div", { class: "row__body" },
            el("div", { class: "row__top" },
                el("div", { class: "row__name" },
                    (c.type === "channel" ? "📢 " : c.type === "group" ? "👥 " : "") + title),
                el("div", { class: "row__time", text: c.last_message_at ? fmtListTime(c.last_message_at) : "" })
            ),
            el("div", { class: "row__bottom" },
                el("div", { class: "row__preview", text: preview }),
                c.ttl_seconds ? el("span", { class: "row__time", title: "Таймер включён" }, "⏱") : null,
                c.muted ? el("span", {
                    class: "row__mute", title: "Без звука",
                    html: '<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 4V6l-5 4H3z"/><path d="M16 9l5 6M21 9l-5 6"/></svg>'
                }) : null,
                c.unread > 0 ? el("span", {
                    class: "row__badge" + (c.muted ? " row__badge--muted" : ""),
                    text: c.unread > 99 ? "99+" : String(c.unread)
                }) : null
            )
        )
    )
    row.onclick = () => openChat(c.chat_id)

    // меню чата: правой кнопкой на компьютере, удержанием на телефоне
    if (isTouch) {
        attachLongPress(row, () => chatRowMenu(c))
        row.oncontextmenu = (e) => e.preventDefault()
    } else {
        row.oncontextmenu = (e) => { e.preventDefault(); chatRowMenu(c) }
    }

    return row
}

async function chatRowMenu(c) {
    const title = chatTitle(c)
    const choice = await modal((box, close) => {
        box.append(
            el("h2", { text: title }),
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("open") }, "💬  Открыть"),
                el("button", { class: "opt", onclick: () => close("mute") },
                    c.muted ? "🔔  Включить звук" : "🔕  Без звука"),
                c.unread > 0
                    ? el("button", { class: "opt", onclick: () => close("read") }, "✓  Отметить прочитанным")
                    : null,
                c.type !== "dm"
                    ? el("button", { class: "opt", style: "color:var(--danger)", onclick: () => close("leave") }, "🚪  Выйти из чата")
                    : null
            )
        )
    })

    try {
        if (choice === "open") openChat(c.chat_id)
        else if (choice === "mute") {
            await db.setMuted(c.chat_id, !c.muted)
            await refreshChats()
        } else if (choice === "read") {
            await db.markRead(c.chat_id)
            await refreshChats()
        } else if (choice === "leave") {
            if (!(await confirmBox({ title: "Выйти из чата?", ok: "Выйти", danger: true }))) return
            await db.leaveChat(c.chat_id)
            if (S.chat && S.chat.chat_id === c.chat_id) closeChat()
            await refreshChats()
        }
    } catch (e) { toast(e.message, true) }
}

/* ============================================================================
   ПОИСК
   ============================================================================ */

function wireFilters() {
    $$("#filters .chip").forEach((chip) => {
        chip.onclick = () => {
            S.filter = chip.dataset.filter
            $$("#filters .chip").forEach((c) => c.classList.toggle("is-active", c === chip))
            renderChatList()
        }
    })
}

function wireSearch() {
    const input = $("#search")
    const box = $("#search-results")
    const bar = $("#search-bar")
    let timer = 0

    const hide = () => { box.hidden = true; box.innerHTML = "" }

    const openSearch = () => {
        bar.hidden = false
        $("#filters").hidden = true
        input.focus()
    }
    const closeSearch = () => {
        input.value = ""
        bar.hidden = true
        $("#filters").hidden = false
        hide()
    }

    $("#btn-search").onclick = () => (bar.hidden ? openSearch() : closeSearch())
    $("#btn-search-close").onclick = closeSearch
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSearch() })

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

    // Скрытия по потере фокуса больше нет: оно срабатывало раньше, чем
    // нажатие по найденной строке, и результаты исчезали из-под пальца.
    // Закрывает поиск теперь только крестик или Escape.
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
    S.fresh.clear()
    S.newWhileAway = 0
    // запоминаем ДО отметки о прочтении: сейчас она обнулится,
    // а черта «непрочитанные» должна встать там, где человек остановился
    S.unreadFrom = row.unread > 0 ? row.last_read_at : null
    closeEmoji()
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
        S.messages = await db.loadMessages(S.chat)
    } catch (e) {
        toast(e.message, true)
    }
    $("#messages-top").innerHTML = ""
    if (S.messages.length < CFG.PAGE_SIZE) S.reachedTop = true

    renderMessages()
    scrollToBottom(false)
    db.markRead(chatId).then(scheduleChatsRefresh)

    // реакции подтягиваются отдельно: в самих сообщениях их нет
    refreshReactions()

    S.unsubChat = db.watchChat(chatId, {
        insert: onIncoming,
        update: onUpdated,
        remove: (old) => removeMessage(old.id),
        reaction: (id) => {
            // чужие реакции прилетают на любые сообщения, что нам видны —
            // пересчитываем только если это сообщение открыто сейчас
            if (S.messages.some((m) => m.id === id)) scheduleReactions()
        }
    })
    S.typing = db.typingChannel(chatId, S.me, onTyping)

    // Канал без права писать — поле ввода прячем
    const canPost = S.chat.type !== "channel" || ["owner", "admin"].includes(S.chat.my_role)
    $("#composer").style.display = canPost ? "" : "none"

    // В группе у каждого сообщения подписан автор, а имена приходят
    // отдельным запросом — не ждём его, лента дорисует подписи сама
    if (row.type !== "dm") primePeople(chatId)

    /* Раздать ключ тем, кто вошёл после нас. Сервер этого сделать не может —
       ключа у него нет, — поэтому раздаёт тот из участников, кто открыл чат
       и ключ имеет. Молча, в фоне. */
    if (row.type !== "dm" && row.encrypted) {
        db.shareKeyWithNewcomers(row).catch(() => { /* не срочно, повторим при следующем открытии */ })
    }

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
        Object.assign(
            avatarNode(title, c.avatar_url, "", c.type === "dm" && isOnline(c.peer_last_seen)),
            { id: "chat-avatar" }
        )
    )
    $("#chat-name").textContent = title

    let status
    if (c.type === "dm") status = fmtLastSeen(c.peer_last_seen)
    else if (c.type === "channel") status = c.username ? "@" + c.username : "канал"
    else status = c.username ? "@" + c.username : "группа"

    if (c.encrypted) status += " · 🔒"
    if (c.ttl_seconds) status += " · ⏱ " + ttlLabel(c.ttl_seconds)
    $("#chat-status").textContent = status
}

/* ============================================================================
   ЛЕНТА СООБЩЕНИЙ
   ============================================================================ */

/* Кнопка «вниз» появляется, когда лента ушла заметно выше конца, и несёт
   число сообщений, пришедших за это время. */
function updateToBottom() {
    const box = $("#messages")
    const btn = $("#btn-to-bottom")
    if (!box || !btn) return

    const away = box.scrollHeight - box.scrollTop - box.clientHeight
    const show = away > 300

    btn.classList.toggle("is-on", show)
    if (!show) S.newWhileAway = 0

    const old = btn.querySelector(".to-bottom__badge")
    if (old) old.remove()
    if (show && S.newWhileAway > 0) {
        btn.append(el("span", {
            class: "to-bottom__badge",
            text: S.newWhileAway > 99 ? "99+" : String(S.newWhileAway)
        }))
    }
}

function wireMessagesScroll() {
    const box = $("#messages")
    box.onscroll = async () => {
        updateToBottom()
        if (box.scrollTop > 120 || S.loadingTop || S.reachedTop || !S.messages.length) return
        S.loadingTop = true
        $("#messages-top").innerHTML = '<div class="spinner"></div>'

        const before = S.messages[0].created_at
        const prevHeight = box.scrollHeight
        try {
            const older = await db.loadMessages(S.chat, before)
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

    /* Плашка про шифрование. Люди не верят на слово, что переписку нельзя
       прочитать, — и правильно делают. Пусть об этом говорит сам чат,
       как в телеге у секретных чатов, а не только README на гитхабе. */
    if (S.chat && S.chat.encrypted) {
        list.append(el("div", { class: "system system--lock" },
            "🔒 Сообщения и файлы в этом чате зашифрованы. Ключ есть только у вас — " +
            "ни сервер, ни владелец сайта прочитать их не могут."))
    }

    let lastDay = ""
    let prev = null
    let dividerDone = false

    S.messages.forEach((m, i) => {
        const day = new Date(m.created_at).toDateString()
        if (day !== lastDay) {
            list.append(el("div", { class: "day", text: fmtDay(m.created_at) }))
            lastDay = day
            prev = null
        }

        /* Черта «непрочитанные» — ровно там, где человек остановился в
           прошлый раз. Ставится один раз и только перед чужим сообщением:
           своё собственное непрочитанным быть не может. */
        if (!dividerDone && S.unreadFrom && m.sender_id !== S.me.id &&
            new Date(m.created_at) > new Date(S.unreadFrom)) {
            list.append(el("div", { class: "unread-line" }, el("span", { text: "Непрочитанные" })))
            dividerDone = true
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

        const node = messageNode(m, { isFirst, isLast })
        if (S.fresh.has(m.id)) node.classList.add("msg--fresh")
        list.append(node)
        prev = m
    })

    // анимация одноразовая: при следующей перерисовке лента не должна
    // заново подпрыгивать целиком
    S.fresh.clear()
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

    if (m.forwarded_from) {
        bubble.append(el("div", { class: "msg__author", text: "Переслано от " + m.forwarded_from }))
    }
    if (m.reply_to) bubble.append(quoteNode(m.reply_to))
    if (m.media && m.media.length) bubble.append(mediaNode(m))

    if (m.body) {
        bubble.append(el("div", {
            class: "msg__text" + (isJumbo(m.body) ? " msg__text--jumbo" : ""),
            html: linkify(m.body)
        }))
    }

    const meta = el("div", { class: "msg__meta" })
    if (m.edited_at) meta.append(el("span", { class: "msg__edited", text: "изм. " }))
    if (m.expires_at) meta.append(el("span", { text: "⏱ " }))
    meta.append(el("span", { text: fmtTime(m.created_at) }))
    if (out) meta.append(ticks(m))
    bubble.append(meta)

    const reacts = S.reactions.get(m.id)
    if (reacts && reacts.length) {
        const box = el("div", { class: "reactions" })
        for (const r of reacts) {
            box.append(el("button", {
                class: "reaction" + (r.mine ? " is-mine" : ""),
                onclick: (e) => { e.stopPropagation(); putReaction(m.id, r.emoji, r.mine) }
            },
                el("span", { class: "reaction__emoji", text: r.emoji }),
                el("span", { text: String(r.n) })
            ))
        }
        bubble.append(box)
    }

    node.append(bubble)

    // Кнопка ответа при наведении — на компьютере правая кнопка мыши
    // не всем очевидна, а тянуть пузырь мышью неудобно
    node.append(el("button", {
        class: "msg__reply-btn",
        title: "Ответить",
        html: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h9a7 7 0 017 7v1"/></svg>',
        onclick: (e) => {
            e.stopPropagation()
            startReply(m)
        }
    }))

    bubble.append(el("span", {
        class: "msg__swipe",
        html: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h9a7 7 0 017 7v1"/></svg>'
    }))

    if (isTouch) attachSwipeReply(node, bubble, m)

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

/*
 * Галочки. Одна — доставлено, две — собеседник прочитал.
 *
 * Отдельной таблицы «кто что прочитал» нет и не нужно: у каждого участника
 * в chat_members уже стоит отметка о последнем прочтении. Если она позже
 * времени сообщения — значит до него добрались. Две галочки бесплатно.
 *
 * В группах показываем одну: «прочитали все» пришлось бы считать по каждому
 * участнику отдельно, а «прочитал хоть кто-то» вводит в заблуждение.
 */
function ticks(m) {
    const read = S.chat.type === "dm" &&
        S.chat.peer_read_at &&
        new Date(S.chat.peer_read_at) >= new Date(m.created_at)

    const node = el("span", {
        class: "msg__ticks" + (read ? " is-read" : ""),
        title: read ? "Прочитано" : "Отправлено",
        html: read
            ? '<svg viewBox="0 0 20 14"><path d="M1 8l3.5 3.5L11 5"/><path d="M8 8l3.5 3.5L19 3"/></svg>'
            : '<svg viewBox="0 0 20 14"><path d="M3 8l3.5 3.5L15 3"/></svg>'
    })
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
        // Голосовое — не плитка в сетке, у него свой вид
        if (item.type === "audio") {
            box.classList.remove("media--1", "media--2", "media--3", "media--4")
            box.append(voiceNode(item))
            return
        }

        const cell = el("div", { class: "media__item" + (item.spoiler ? " is-spoiler" : "") })

        /* Адрес добывается асинхронно: зашифрованный файл надо сначала
           скачать и расшифровать в браузере. Поэтому элемент создаётся
           пустым и наполняется, когда данные готовы. */
        let url = null
        const surface = item.type === "video"
            ? el("video", { preload: "metadata", playsinline: true, muted: true })
            : el("img", { alt: "", loading: "lazy" })
        cell.append(surface)

        db.mediaSrc(item, S.chat).then((u) => {
            url = u
            surface.src = u
        }).catch((e) => {
            cell.append(el("div", { class: "media__hint", text: e.message }))
        })

        if (item.type === "video") {
            cell.append(el("div", { class: "media__play" },
                el("span", { html: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>' })))
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
            if (!url) return toast("Файл ещё грузится")
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

/*
 * Голосовое сообщение. Звук грузится и расшифровывается только при первом
 * нажатии: тянуть все войсы в чате сразу — значит выкачивать мегабайты,
 * которые никто не собирался слушать.
 */
function voiceNode(item) {
    const fill = el("i", { class: "voice__fill" })
    const time = el("div", { class: "voice__time", text: fmtDuration(item.dur || 0) })
    const icon = (playing) => playing
        ? '<svg viewBox="0 0 24 24"><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>'

    const btn = el("button", { class: "voice__play", html: icon(false) })
    let audio = null
    let loading = false

    btn.onclick = async (e) => {
        e.stopPropagation()

        if (audio) {
            if (audio.paused) audio.play()
            else audio.pause()
            return
        }
        if (loading) return
        loading = true
        btn.textContent = "…"

        try {
            const url = await db.mediaSrc(item, S.chat)
            audio = new Audio(url)
            audio.onplay = () => { btn.innerHTML = icon(true) }
            audio.onpause = () => { btn.innerHTML = icon(false) }
            audio.onended = () => {
                btn.innerHTML = icon(false)
                fill.style.width = "0"
                time.textContent = fmtDuration(item.dur || 0)
            }
            audio.ontimeupdate = () => {
                const total = audio.duration || item.dur || 1
                fill.style.width = Math.min(100, (audio.currentTime / total) * 100) + "%"
                time.textContent = fmtDuration(audio.currentTime)
            }
            await audio.play()
        } catch (err) {
            btn.innerHTML = icon(false)
            toast(err.message || "Не вышло проиграть", true)
        } finally {
            loading = false
        }
    }

    return el("div", { class: "voice" },
        btn,
        el("div", { class: "voice__body" },
            el("div", { class: "voice__bar" }, fill),
            time
        )
    )
}

function showFullMedia(item, url) {
    const node = item.type === "video"
        ? el("video", { src: url, controls: true, autoplay: true, playsinline: true })
        : el("img", { src: url, alt: "" })
    openViewer(node)
}

/** Сообщение из одних эмодзи рисуем крупно — как в телеге. */
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}️‍\s]+$/u

function isJumbo(text) {
    const t = text.trim()
    if (!t || t.length > 40) return false
    let ok
    try { ok = EMOJI_ONLY.test(t) } catch { return false }
    if (!ok) return false
    const n = segments(t).filter((s) => s.trim()).length
    return n > 0 && n <= 3
}

function startReply(m) {
    S.editing = null
    S.replyTo = m
    renderReplyBar()
    $("#input").focus()
}

/*
 * Свайп для ответа. Тянем пузырь влево (у своих — вправо), после порога
 * отпускаем — и сообщение уходит в цитату.
 *
 * Главная тонкость: жест обязан уступать вертикальной прокрутке. Пока не
 * ясно, куда ведут палец, ничего не двигаем; как только движение оказалось
 * заметно горизонтальным — перехватываем, иначе навсегда отдаём прокрутке.
 */
function attachSwipeReply(node, bubble, m) {
    const MAX = 64
    const TRIGGER = 48

    let x0 = 0, y0 = 0
    let axis = null     // null — ещё не решили, "x" — наш, "y" — прокрутка
    let dx = 0

    const icon = bubble.querySelector(".msg__swipe")
    const out = node.classList.contains("msg--out")
    const dir = out ? 1 : -1

    node.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return
        x0 = e.touches[0].clientX
        y0 = e.touches[0].clientY
        axis = null
        dx = 0
    }, { passive: true })

    node.addEventListener("touchmove", (e) => {
        if (e.touches.length !== 1) return
        const mx = e.touches[0].clientX - x0
        const my = e.touches[0].clientY - y0

        if (axis === null) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
            axis = Math.abs(mx) > Math.abs(my) * 1.4 ? "x" : "y"
            if (axis === "x") node.classList.add("is-dragging")
        }
        if (axis !== "x") return

        // тянуть можно только в свою сторону, и не дальше упора
        dx = Math.min(Math.max(0, mx * dir), MAX)
        const shift = dx * dir
        bubble.style.transform = `translateX(${shift}px)`
        if (icon) icon.style.opacity = String(Math.min(1, dx / TRIGGER))
    }, { passive: true })

    const release = () => {
        if (axis === "x") {
            node.classList.remove("is-dragging")
            bubble.style.transform = ""
            if (icon) icon.style.opacity = "0"
            if (dx >= TRIGGER) {
                if (navigator.vibrate) navigator.vibrate(10)
                startReply(m)
            }
        }
        axis = null
        dx = 0
    }

    node.addEventListener("touchend", release)
    node.addEventListener("touchcancel", release)
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

/** Быстрые реакции — те же, что предлагает телега первым рядом. */
const QUICK_REACTIONS = ["👍", "❤️", "🔥", "😂", "😮", "😢", "🙏", "💩"]

async function putReaction(messageId, emoji, mine) {
    try {
        await db.toggleReaction(messageId, emoji, mine)
        await refreshReactions()
    } catch (e) { toast(e.message, true) }
}

/* Реакции ставят очередями — по три подряд на одно сообщение. Каждое
   событие тянуть заново бессмысленно, поэтому они сливаются в один запрос. */
let reactTimer = 0
function scheduleReactions() {
    clearTimeout(reactTimer)
    reactTimer = setTimeout(refreshReactions, 250)
}

async function refreshReactions() {
    if (!S.messages.length) return
    try {
        S.reactions = await db.loadReactions(S.messages.map((m) => m.id))
        renderMessages()
    } catch { /* реакции — не то, ради чего стоит ругаться на весь экран */ }
}

async function messageMenu(m) {
    const mine = m.sender_id === S.me.id
    const admin = ["owner", "admin"].includes(S.chat.my_role)

    const choice = await modal((box, close) => {
        // Ряд быстрых реакций поверх меню — как в телеге, чтобы поставить
        // сердечко за одно нажатие, а не через список пунктов
        const quick = el("div", { class: "opt-list", style: "display:flex;gap:4px;margin:0 0 14px" })
        const existing = S.reactions.get(m.id) || []
        for (const e of QUICK_REACTIONS) {
            const mineNow = existing.some((r) => r.emoji === e && r.mine)
            quick.append(el("button", {
                class: "emoji-panel__btn" + (mineNow ? " is-mine" : ""),
                style: "flex:1;aspect-ratio:auto;padding:8px 0" +
                    (mineNow ? ";background:var(--accent-soft)" : ""),
                onclick: () => { close(null); putReaction(m.id, e, mineNow) }
            }, e))
        }

        box.append(
            el("h2", { text: "Сообщение" }),
            quick,
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("reply") }, "↩︎  Ответить"),
                el("button", { class: "opt", onclick: () => close("forward") }, "➦  Переслать"),
                m.body ? el("button", { class: "opt", onclick: () => close("copy") }, "⧉  Скопировать текст") : null,
                mine && m.body ? el("button", { class: "opt", onclick: () => close("edit") }, "✎  Изменить") : null,
                (mine || admin) ? el("button", {
                    class: "opt", style: "color:var(--danger)", onclick: () => close("delete")
                }, "🗑  Удалить") : null
            )
        )
    })

    if (choice === "forward") return forwardDialog(m)

    if (choice === "reply") {
        startReply(m)
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

/*
 * Пересылка. Текст шифруется заново ключом чата-получателя — у каждого чата
 * свой ключ, старый шифротекст там нечем открыть.
 *
 * Из-за этого зашифрованные вложения не пересылаются: их пришлось бы скачать,
 * расшифровать, зашифровать другим ключом и залить заново. Честнее сказать
 * об этом прямо, чем молча отправить кусок, который не откроется.
 */
async function forwardDialog(m) {
    const targets = S.chats.filter((c) =>
        c.chat_id !== S.chat.chat_id &&
        (c.type !== "channel" || ["owner", "admin"].includes(c.my_role))
    )

    if (!targets.length) return toast("Некуда пересылать — других чатов нет", true)

    const hadEncryptedMedia = !!(m.media && m.media.some((x) => x.iv))

    const target = await modal((box, close) => {
        box.append(
            el("h2", { text: "Переслать" }),
            hadEncryptedMedia
                ? el("p", { class: "modal__sub", text:
                    "Вложение переслать нельзя: оно зашифровано ключом этого чата. Уйдёт только текст." })
                : null
        )
        const list = el("div", { class: "opt-list", style: "max-height:46vh;overflow-y:auto" })
        for (const c of targets) {
            const row = el("button", { class: "opt", onclick: () => close(c) },
                avatarNode(chatTitle(c), c.avatar_url, "avatar--sm"),
                el("span", { style: "flex:1", text: chatTitle(c) })
            )
            list.append(row)
        }
        box.append(list, el("div", { class: "modal__actions" },
            el("button", { class: "btn btn--ghost", onclick: () => close(null) }, "Отмена")))
    })

    if (!target) return

    try {
        await db.forwardMessage(m, S.chat, target, findName(m.sender_id))
        toast("Переслано в «" + chatTitle(target) + "»")
        scheduleChatsRefresh()
    } catch (e) { toast(e.message, true) }
}

/* ============================================================================
   ВХОДЯЩИЕ
   ============================================================================ */

async function onIncoming(raw) {
    if (!S.chat || raw.chat_id !== S.chat.chat_id) return
    if (S.messages.some((x) => x.id === raw.id)) return

    // Живое обновление приходит из базы как есть — то есть зашифрованным
    const row = await db.decryptIncoming(raw, S.chat)

    // Пока расшифровывали, чат могли переключить
    if (!S.chat || row.chat_id !== S.chat.chat_id) return
    if (S.messages.some((x) => x.id === row.id)) return

    const box = $("#messages")
    // если человек читает старое, дёргать его вниз нельзя
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140

    S.messages.push(row)
    S.fresh.add(row.id)
    renderMessages()

    if (atBottom) {
        scrollToBottom(true)
    } else if (row.sender_id !== S.me.id) {
        // человек внизу ленты не был — сообщение он не увидел,
        // и об этом должна сказать кнопка «вниз»
        S.newWhileAway++
        updateToBottom()
    }

    db.markRead(S.chat.chat_id)
    if (row.sender_id !== S.me.id) S.typingWho.delete(row.sender_id)
    renderTyping()
}

async function onUpdated(raw) {
    const i = S.messages.findIndex((x) => x.id === raw.id)
    if (i < 0) return
    if (raw.deleted) return removeMessage(raw.id)

    // body у правки приходит зашифрованным ровно так же, как у новой
    const row = raw.body != null && !raw.enc ? raw : await db.decryptIncoming(raw, S.chat)

    const j = S.messages.findIndex((x) => x.id === row.id)
    if (j < 0) return
    S.messages[j] = row
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

/* ============================================================================
   ЭМОДЗИ

   Список свой, а не системная клавиатура: на компьютере её просто нет, а на
   телефоне она закрывает пол-экрана и теряет переписку из виду.
   ============================================================================ */

const EMOJI = [
    ["😀", "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙🥲😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🤧🥵🥶🥴😵😵‍💫🤯🤠🥳🥸😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡"],
    ["👍", "👍👎👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️✋🤚🖐️🖖👋🤝🙏✍️💅🤳💪🦾🦵🦶👂👃🧠🫀👀👁️👅👄💋🫶🤲👐🙌👏🫰"],
    ["❤️", "❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟♥️💯💢💥💫💦💨🕳️💬💭🗯️♨️"],
    ["🔥", "🔥⭐️🌟✨⚡️☄️💥🌈☀️🌤️⛅️🌥️☁️🌦️🌧️⛈️🌩️🌨️❄️☃️⛄️🌬️💨🌪️🌫️🌊💧🫧🌙⭐️🌕🌖🌗🌘🌑🌒🌓🌔"],
    ["🐱", "🐶🐱🐭🐹🐰🦊🐻🐼🐻‍❄️🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐒🦆🦅🦉🦇🐺🐗🐴🦄🐝🪱🐛🦋🐌🐞🐜🪰🕷️🦂🐢🐍🦎🐙🦑🦐🦞🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🦧🐘🦛🦏🐪🐫🦒🦘🦬🐃🐂🐄🐎🐖🐏🐑🦙🐐🦌🐕🐩🦮🐈🐓🦃🦚🦜🦢🕊️🐇🦝🦨🦡🦫🦦🦥🐁🐀🐿️🦔"],
    ["🍕", "🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶️🫑🌽🥕🫒🧄🧅🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🧈🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🫓🥪🌮🌯🫔🥙🧆🥘🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍘🍥🥠🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪☕️🍵🧃🥤🧋🍺🍻🥂🍷🥃🍸🍹🧉"],
    ["⚽️", "⚽️🏀🏈⚾️🥎🎾🏐🏉🥏🎱🪀🏓🏸🏒🏑🥍🏏🪃🥅⛳️🪁🏹🎣🤿🥊🥋🎽🛹🛼🛷⛸️🥌🎿⛷️🏂🏋️🤼🤸⛹️🤺🤾🏌️🏇🧘🏄🏊🤽🚣🧗🚴🚵🏆🥇🥈🥉🏅🎖️🎗️🎫🎪🤹🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🪕🎻🎲♟️🎯🎳🎮🎰🧩"],
    ["✅", "✅❌❎➕➖➗✖️❓❔❕❗️‼️⁉️〰️💱💲⚕️♻️⚜️🔱📛🔰⭕️✔️☑️🔘🔴🟠🟡🟢🔵🟣⚫️⚪️🟤🔺🔻🔸🔹🔶🔷🔳🔲▪️▫️◾️◽️◼️◻️⬛️⬜️🟥🟧🟨🟩🟦🟪⬆️↗️➡️↘️⬇️↙️⬅️↖️↕️↔️↩️↪️🔄🔃🔙🔚🔛🔜🔝🔒🔓🔏🔐🔑🗝️"]
]

/* Разбор строки на «то, что человек считает одним символом». Делить по
   кодовым точкам нельзя: флаг, эмодзи с цветом кожи или семья из четырёх
   человечков — это несколько кодовых точек, и такое деление рвёт их в клочья. */
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter() : null

function segments(str) {
    if (segmenter) return Array.from(segmenter.segment(str), (s) => s.segment)
    return Array.from(str)
}

const RECENT_KEY = "qiwi.emoji.recent"

function readRecent() {
    try {
        const raw = localStorage.getItem(RECENT_KEY)
        return raw ? JSON.parse(raw) : []
    } catch { return [] }
}

function pushRecent(e) {
    // недавние впереди, без повторов, не больше строки
    const list = [e, ...readRecent().filter((x) => x !== e)].slice(0, 24)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* пусто */ }
}

function closeEmoji() {
    const panel = $("#emoji-panel")
    if (panel) panel.remove()
    $("#btn-emoji").classList.remove("is-on")
}

function toggleEmoji() {
    if ($("#emoji-panel")) return closeEmoji()

    const btn = $("#btn-emoji")
    btn.classList.add("is-on")

    const grid = el("div", { class: "emoji-panel__grid" })
    const tabs = el("div", { class: "emoji-panel__tabs" })

    const recent = readRecent()
    const groups = recent.length ? [["🕘", recent.join("")], ...EMOJI] : EMOJI

    const fill = (chars) => {
        grid.innerHTML = ""
        // по кодовым точкам разбивать нельзя: флаги и эмодзи с модификаторами
        // состоят из нескольких, и их бы порвало на куски
        for (const e of segments(chars)) {
            if (!e.trim()) continue
            grid.append(el("button", {
                class: "emoji-panel__btn",
                onclick: () => insertEmoji(e)
            }, e))
        }
        grid.scrollTop = 0
    }

    groups.forEach(([icon, chars], i) => {
        const tab = el("button", {
            class: "emoji-panel__tab" + (i === 0 ? " is-active" : ""),
            onclick: () => {
                $$(".emoji-panel__tab").forEach((t) => t.classList.toggle("is-active", t === tab))
                fill(chars)
            }
        }, icon)
        tabs.append(tab)
    })

    fill(groups[0][1])

    const panel = el("div", { class: "emoji-panel", id: "emoji-panel" }, tabs, grid)
    $("#composer").append(panel)
}

function insertEmoji(e) {
    pushRecent(e)
    const input = $("#input")
    input.focus()
    // execCommand устарел, но это единственный способ вставить текст в
    // contenteditable так, чтобы отмена по Ctrl+Z продолжала работать
    document.execCommand("insertText", false, e)
    input.dispatchEvent(new Event("input"))
}

function wireComposer() {
    const input = $("#input")
    const send = $("#btn-send")

    $("#btn-emoji").onclick = toggleEmoji
    // клик мимо панели закрывает её; на самой панели и на кнопке — нет
    document.addEventListener("pointerdown", (e) => {
        if (!$("#emoji-panel")) return
        if (e.target.closest("#emoji-panel") || e.target.closest("#btn-emoji")) return
        closeEmoji()
    })

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

    /* Кнопка справа переключается между микрофоном и самолётиком: пустое
       поле — значит человек собирается говорить, есть текст — отправлять.
       Так же устроено в телеге и вотсапе. */
    const syncSendButton = () => {
        const has = input.innerText.trim().length > 0 || S.attach.length > 0
        $("#btn-send").hidden = !has
        $("#btn-mic").hidden = has || !voiceSupported()
    }
    input.addEventListener("input", syncSendButton)
    S.syncSendButton = syncSendButton
    syncSendButton()

    wireRecorder()

    // перетаскивание файлов прямо в окно чата
    const chat = $("#chat")
    chat.addEventListener("dragover", (e) => e.preventDefault())
    chat.addEventListener("drop", (e) => {
        e.preventDefault()
        if (!S.chat) return
        addAttachments(Array.from(e.dataTransfer.files || []))
    })
}

/* ============================================================================
   ПОИСК ПО ПЕРЕПИСКЕ

   Ищет устройство, а не сервер, и только по загруженной части переписки.
   Причина прямая: сервер хранит шифротекст и искать в нём не может — ни по
   слову, ни по букве. Это цена шифрования, обойти её нельзя, поэтому под
   строкой поиска честно написано, сколько сообщений уже подгружено.
   ============================================================================ */

function clearHits() {
    S.hits = []
    S.hitAt = -1
    $$(".msg.is-hit").forEach((n) => n.classList.remove("is-hit"))
    $("#chat-search-count").textContent = ""
}

function gotoHit(i) {
    if (!S.hits.length) return
    S.hitAt = (i + S.hits.length) % S.hits.length
    $$(".msg.is-hit").forEach((n) => n.classList.remove("is-hit"))

    const id = S.hits[S.hitAt]
    const node = $(`.msg[data-id="${id}"]`)
    if (node) {
        node.classList.add("is-hit")
        node.scrollIntoView({ block: "center", behavior: "smooth" })
    }
    $("#chat-search-count").textContent = (S.hitAt + 1) + " / " + S.hits.length
}

function runChatSearch(q) {
    clearHits()
    const needle = q.trim().toLowerCase()
    if (!needle) return

    S.hits = S.messages
        .filter((m) => (m.body || "").toLowerCase().includes(needle))
        .map((m) => m.id)

    if (!S.hits.length) {
        $("#chat-search-count").textContent = "нет"
        return
    }
    // начинаем с самого свежего совпадения — обычно ищут недавнее
    gotoHit(S.hits.length - 1)
}

function wireChatSearch() {
    const bar = $("#chat-search")
    const input = $("#chat-search-input")

    const close = () => {
        bar.hidden = true
        input.value = ""
        clearHits()
    }

    $("#btn-chat-search").onclick = () => {
        if (!S.chat) return
        bar.hidden = false
        input.focus()
        toast(`Ищу среди ${S.messages.length} загруженных сообщений`)
    }
    $("#chat-search-close").onclick = close
    $("#chat-search-prev").onclick = () => gotoHit(S.hitAt - 1)
    $("#chat-search-next").onclick = () => gotoHit(S.hitAt + 1)

    let timer = 0
    input.addEventListener("input", () => {
        clearTimeout(timer)
        timer = setTimeout(() => runChatSearch(input.value), 200)
    })
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close()
        if (e.key === "Enter") gotoHit(e.shiftKey ? S.hitAt - 1 : S.hitAt + 1)
    })
}

/* ------------------------------ голосовые ------------------------------ */

function showRecorder(on) {
    $("#recorder").hidden = !on
    $("#composer").hidden = on
}

function wireRecorder() {
    $("#btn-mic").onclick = async () => {
        if (S.rec) return
        try {
            S.rec = await startRecording((sec) => {
                $("#rec-time").textContent = fmtDuration(sec)
                // дальше пяти минут никто не слушает, да и место не резиновое
                if (sec > 300) $("#btn-rec-send").click()
            })
            $("#rec-time").textContent = "0:00"
            showRecorder(true)
        } catch (e) {
            toast(e.message, true)
        }
    }

    $("#btn-rec-cancel").onclick = () => {
        if (!S.rec) return
        S.rec.cancel()
        S.rec = null
        showRecorder(false)
    }

    $("#btn-rec-send").onclick = async () => {
        if (!S.rec) return
        const rec = S.rec
        S.rec = null
        showRecorder(false)

        let taken
        try {
            taken = await rec.stop()
        } catch {
            return toast("Запись не удалась", true)
        }
        // меньше секунды — это случайное нажатие, а не сообщение
        if (taken.seconds < 1 || taken.blob.size < 900) {
            return toast("Слишком короткая запись")
        }

        try {
            const item = await db.uploadVoice(taken.blob, {
                seconds: taken.seconds,
                mime: taken.mime,
                chat: S.chat
            })
            const row = await db.sendMessage({ chat: S.chat, media: [item] })
            onIncoming(row)
            scrollToBottom(true)
            scheduleChatsRefresh()
        } catch (e) {
            toast(e.message, true)
        }
    }
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
            const updated = await db.editMessage(target.id, body, S.chat)
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
                db.uploadMedia(a.file, { spoiler: a.spoiler, chat: S.chat })))
            files.forEach((a) => URL.revokeObjectURL(a.url))
        }

        const row = await db.sendMessage({
            chat: S.chat,
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

        // Закрытый чат шифруется, и ключ ему заводит создатель — больше
        // никто этого сделать не может, у сервера ключа нет
        if (!result.isPublic) await db.initGroupKey(id)

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

    // Для лички важно знать, заблокирован ли собеседник — от этого зависит
    // подпись кнопки. Ошибка тут не должна ломать всё окно.
    const blocked = c.type === "dm" && c.peer_id
        ? await db.isBlockedByMe(c.peer_id).catch(() => false)
        : false

    const action = await modal((box, close) => {
        box.append(
            el("h2", { text: chatTitle(c) }),
            c.username ? el("p", { class: "modal__sub", text: "@" + c.username }) : null,
            c.type !== "dm"
                ? el("p", { class: "modal__sub", text: `${people.length} ${plural(people.length, "участник", "участника", "участников")}` })
                : null,
            el("p", { class: "modal__sub", text: c.encrypted
                ? "🔒 Сквозное шифрование. Текст и файлы шифруются у тебя в браузере ключом, которого на сервере нет. Владелец сайта прочитать переписку не может — только увидеть, что она была."
                : "🌐 Без шифрования: это публичный чат, его содержимое открыто по замыслу." }),
            el("div", { class: "opt-list" },
                el("button", { class: "opt", onclick: () => close("ttl") },
                    "⏱  Самоуничтожение: " + (c.ttl_seconds ? ttlLabel(c.ttl_seconds) : "выключено")),
                c.type !== "dm" && !c.is_public
                    ? el("button", { class: "opt", onclick: () => close("invite") }, "🔗  Ссылка-приглашение")
                    : null,
                c.type !== "dm"
                    ? el("button", { class: "opt", onclick: () => close("people") }, "👥  Участники")
                    : null,
                (c.type !== "dm" && admin)
                    ? el("button", { class: "opt", onclick: () => close("avatar") }, "🖼  Фото чата")
                    : null,
                c.type !== "dm"
                    ? el("button", { class: "opt", style: "color:var(--danger)", onclick: () => close("leave") }, "🚪  Выйти")
                    : null,
                c.type === "dm"
                    ? el("button", {
                        class: "opt",
                        style: blocked ? "" : "color:var(--danger)",
                        onclick: () => close("block")
                    }, blocked ? "🔓  Разблокировать" : "🚫  Заблокировать")
                    : null,
                (c.my_role === "owner" && c.type !== "dm")
                    ? el("button", { class: "opt", style: "color:var(--danger)", onclick: () => close("delete") }, "🗑  Удалить навсегда")
                    : null
            )
        )
    })

    if (action === "block") {
        try {
            if (blocked) {
                await db.unblockUser(c.peer_id)
                toast("Разблокирован")
            } else {
                const ok = await confirmBox({
                    title: "Заблокировать?",
                    text: "Он больше не сможет тебе написать. Переписка останется, но новых сообщений от него не будет.",
                    ok: "Заблокировать", danger: true
                })
                if (!ok) return
                await db.blockUser(c.peer_id)
                toast("Заблокирован")
            }
        } catch (e) { toast(e.message, true) }
        return
    }

    if (action === "ttl") return ttlDialog()
    if (action === "invite") return inviteDialog()
    if (action === "people") return peopleDialog(people, admin)
    if (action === "avatar") return chatAvatarDialog()

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

/**
 * Кружок, по которому выбирают картинку. Возвращает узел и способ узнать,
 * что выбрали: сам файл или пометку «убрать».
 *
 * Предпросмотр показывается сразу, ещё до отправки — иначе непонятно,
 * как именно обрежется картинка, и человек выбирает вслепую.
 */
function avatarPicker(name, currentUrl) {
    const state = { file: null, remove: false }

    const preview = avatarNode(name, currentUrl, "avatar--lg")
    const input = el("input", { type: "file", accept: "image/*", hidden: true })

    input.onchange = () => {
        const file = input.files && input.files[0]
        if (!file) return
        state.file = file
        state.remove = false
        // старую ссылку освобождать не надо: она живёт до закрытия окна
        const url = URL.createObjectURL(file)
        preview.innerHTML = ""
        preview.style.background = "transparent"
        preview.append(el("img", { src: url, alt: "" }))
    }

    const clear = el("button", {
        class: "btn btn--ghost",
        style: "width:auto;padding:8px 14px;font-size:13px",
        onclick: () => {
            state.file = null
            state.remove = true
            preview.innerHTML = ""
            preview.style.background = avatarColor(name)
            preview.textContent = initials(name)
        }
    }, "Убрать")

    const wrap = el("div", { class: "avatar-pick" },
        el("button", {
            class: "avatar-pick__btn",
            onclick: () => input.click(),
            title: "Выбрать картинку"
        }, preview),
        el("div", { class: "avatar-pick__side" },
            el("button", {
                class: "btn btn--ghost",
                style: "width:auto;padding:8px 14px;font-size:13px",
                onclick: () => input.click()
            }, "Выбрать фото"),
            currentUrl ? clear : null
        ),
        input
    )

    return { node: wrap, state }
}

async function editProfileDialog() {
    const pick = avatarPicker(S.me.display_name || S.me.username, S.me.avatar_url)

    const result = await modal((box, close) => {
        const name = el("input", { type: "text", value: S.me.display_name || "" })
        const bio = el("input", { type: "text", value: S.me.bio || "", placeholder: "необязательно" })
        box.append(
            el("h2", { text: "Профиль" }),
            el("p", { class: "modal__sub", text: "Ник @" + S.me.username + " изменить нельзя — на него ссылаются другие." }),
            pick.node,
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
        if (pick.state.file) {
            toast("Загружаю фото…")
            result.avatar_url = await db.uploadAvatar(pick.state.file, S.me.avatar_url)
        } else if (pick.state.remove) {
            result.avatar_url = null
            await db.clearAvatarFile(S.me.avatar_url)
        }
        S.me = await db.updateProfile(result)
        renderMe()
        renderChatList()
        toast("Сохранено")
    } catch (e) { toast(e.message, true) }
}

/** Фото группы или канала — то же самое, но для чата. */
async function chatAvatarDialog() {
    const c = S.chat
    const pick = avatarPicker(chatTitle(c), c.avatar_url)

    const ok = await modal((box, close) => {
        box.append(
            el("h2", { text: "Фото чата" }),
            el("p", { class: "modal__sub", text: "Его увидят все участники." }),
            pick.node,
            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(false) }, "Отмена"),
                el("button", { class: "btn btn--primary", onclick: () => close(true) }, "Сохранить")
            )
        )
    })
    if (!ok) return

    try {
        if (pick.state.file) {
            toast("Загружаю фото…")
            await db.setChatAvatar(c.chat_id, pick.state.file, c.avatar_url)
        } else if (pick.state.remove) {
            await db.clearChatAvatar(c.chat_id, c.avatar_url)
        } else return

        await refreshChats()
        renderChatHeader()
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

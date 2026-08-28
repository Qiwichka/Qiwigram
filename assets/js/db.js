/* db.js — всё общение с Supabase. Выше этого файла SQL и ключи не поднимаются. */

import * as cr from "./crypto.js"

/*
 * Библиотека лежит в самом проекте (assets/vendor/supabase.js) и подключается
 * обычным <script> до модулей. Раньше она тянулась из чужого CDN прямо
 * инструкцией import — и это оказалось плохой идеей: когда такой import
 * не проходит, модуль не выполняется ЦЕЛИКОМ и молча, без единой строчки
 * в интерфейсе. Человек видит вечную полоску загрузки и не знает почему.
 * Свой файл ещё и кэшируется служебным работником, то есть приложение
 * открывается без сети.
 */
if (!window.supabase || !window.supabase.createClient) {
    throw new Error("Не загрузилась библиотека Supabase (assets/vendor/supabase.js)")
}
const { createClient } = window.supabase

const CFG = window.QIWI

/*
 * Замок для межвкладочной синхронизации токена.
 *
 * По умолчанию библиотека берёт обычный Web Lock и ЖДЁТ его освобождения.
 * Стоит одной вкладке захватить замок и зависнуть — все остальные встают
 * намертво на чтении сессии, без ошибки и без единого следа: заставка
 * висит, консоль пуста. Ровно это и происходило.
 *
 * Здесь замок берётся только если он свободен (ifAvailable). Занят — работаем
 * без него. Худшее, что случится: две вкладки одновременно обновят токен, и
 * одна из двух попыток окажется лишней. Это несравнимо дешевле, чем намертво
 * заклинившее приложение.
 */
async function tabLock(name, _acquireTimeout, fn) {
    if (!navigator.locks || !navigator.locks.request) return fn()
    try {
        return await navigator.locks.request(name, { ifAvailable: true }, () => fn())
    } catch {
        // сюда попадаем, например, в приватном окне, где замки недоступны
        return fn()
    }
}

export const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Сессия должна переживать закрытие приложения: в обёртке APK человек
        // не станет вводить пароль при каждом запуске.
        storageKey: "qiwi.auth",
        lock: tabLock
    },
    realtime: { params: { eventsPerSecond: 12 } }
})

/** Ник -> адрес для авторизации. Почему синтетический — см. config.js. */
const authEmail = (username) => `${String(username).toLowerCase()}@${CFG.AUTH_DOMAIN}`

/* ============================================================================
   ОШИБКИ
   ============================================================================ */

/*
 * Supabase отвечает кодами и английскими фразами. Показывать их человеку
 * бессмысленно, поэтому здесь единственное место, где они превращаются
 * в понятный текст.
 */
const MESSAGES = {
    invalid_credentials: "Неверный ник или пароль",
    user_already_exists: "Такой ник уже занят",
    username_taken: "Такой ник уже занят",
    weak_password: "Слишком простой пароль — нужно минимум 6 символов",
    over_request_rate_limit: "Слишком часто. Подожди минуту и попробуй снова",
    not_member: "Ты больше не участник этого чата",
    not_admin: "Нужны права администратора",
    invite_required: "Чат закрытый — нужна ссылка-приглашение",
    no_such_user: "Такого пользователя нет",
    cannot_dm_self: "Нельзя написать самому себе",
    /* Одинаковый текст в обе стороны намеренно: по разным сообщениям можно
       было бы выяснить, заблокировал тебя человек или ты его. */
    blocked: "Переписка с этим человеком недоступна"
}

export function humanError(err) {
    if (!err) return "Что-то пошло не так"
    const raw = (err.code || err.message || "").toString()

    for (const key of Object.keys(MESSAGES)) {
        if (raw.includes(key)) return MESSAGES[key]
    }
    if (raw.includes("23505")) return "Такой ник уже занят"
    if (raw.includes("duplicate key")) return "Такой ник уже занят"
    if (raw.includes("Invalid login")) return MESSAGES.invalid_credentials
    if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
        return "Нет связи с сервером"
    }
    return err.message || "Что-то пошло не так"
}

/** Разворачивает ответ Supabase, бросая уже человеческую ошибку. */
function unwrap({ data, error }) {
    if (error) {
        const e = new Error(humanError(error))
        e.original = error
        throw e
    }
    return data
}

/* ============================================================================
   ВХОД И РЕГИСТРАЦИЯ
   ============================================================================ */

export async function usernameFree(name) {
    if (!CFG.USERNAME_RE.test(name)) return false
    const { data, error } = await sb.rpc("username_available", { _name: name })
    if (error) return false
    return data === true
}

/* ============================================================================
   КЛЮЧИ

   Закрытый ключ живёт в памяти вкладки и в localStorage этого устройства.
   На сервере он есть только в зашифрованном паролем виде.
   ============================================================================ */

let myPrivate = null                 // CryptoKey
let myPublicJwk = null
const chatKeys = new Map()           // chat_id -> CryptoKey
const pubKeyCache = new Map()        // user_id -> jwk

export function keysReady() { return myPrivate !== null }

/** Первый заход: заводим пару и раскладываем её по местам. */
async function createKeysFor(userId, password) {
    const pair = await cr.generateKeyPair()
    const pubJwk = await cr.exportPublic(pair)
    const privJwk = await cr.exportPrivate(pair)
    const guarded = await cr.protectPrivateKey(privJwk, password)

    unwrap(await sb.from("profiles").update({ public_key: pubJwk }).eq("id", userId))
    unwrap(await sb.from("user_private").update({ private_key_enc: guarded }).eq("id", userId))

    myPrivate = pair.privateKey
    myPublicJwk = pubJwk
    cr.cachePrivateKey(privJwk)
}

/**
 * Достать закрытый ключ. Сначала с устройства, потом — расшифровав паролем.
 * Возвращает false, если ключа нет и пароля не дали: тогда переписку видно
 * не будет, но само приложение работает.
 */
export async function loadKeys(password = null) {
    const session = await currentSession()
    if (!session) return false

    const cached = cr.readCachedPrivateKey()
    if (cached) {
        try {
            myPrivate = await cr.importPrivate(cached)
            const { data } = await sb.from("profiles")
                .select("public_key").eq("id", session.user.id).single()
            myPublicJwk = data && data.public_key
            if (myPublicJwk) return true
        } catch { /* ключ на устройстве испорчен — пойдём длинным путём */ }
    }

    const { data: priv } = await sb.from("user_private")
        .select("private_key_enc").eq("id", session.user.id).single()

    // Ключей нет вовсе — аккаунт заведён до появления шифрования
    if (!priv || !priv.private_key_enc) {
        if (!password) return false
        await createKeysFor(session.user.id, password)
        return true
    }

    if (!password) return false

    const jwk = await cr.unlockPrivateKey(priv.private_key_enc, password)
    myPrivate = await cr.importPrivate(jwk)
    cr.cachePrivateKey(jwk)

    const { data: prof } = await sb.from("profiles")
        .select("public_key").eq("id", session.user.id).single()
    myPublicJwk = prof && prof.public_key
    return true
}

export function dropKeys() {
    myPrivate = null
    myPublicJwk = null
    chatKeys.clear()
    cr.forgetPrivateKey()
}

async function publicKeyOf(userId) {
    if (pubKeyCache.has(userId)) return pubKeyCache.get(userId)
    const { data } = await sb.rpc("public_key_of", { _user: userId })
    pubKeyCache.set(userId, data || null)
    return data || null
}

/**
 * Ключ конкретного чата. Для лички считается на месте, для группы
 * достаётся завёрнутым и разворачивается. null — читать нечем.
 */
export async function chatKey(chat) {
    if (!chat || !chat.encrypted || !myPrivate) return null

    const id = chat.chat_id || chat.id
    if (chatKeys.has(id)) return chatKeys.get(id)

    let key = null

    if (chat.type === "dm") {
        const peer = chat.peer_id || (await otherMember(id))
        if (!peer) return null
        const pub = await publicKeyOf(peer)
        // Собеседник ещё не заходил после появления шифрования
        if (!pub) return null
        key = await cr.dmKey(myPrivate, pub)
    } else {
        const session = await currentSession()
        const { data: row } = await sb.from("chat_keys")
            .select("wrapped, wrapped_by")
            .eq("chat_id", id).eq("user_id", session.user.id).maybeSingle()

        if (row) {
            const pub = await publicKeyOf(row.wrapped_by)
            if (!pub) return null
            try {
                key = await cr.unwrapGroupKey(row.wrapped, myPrivate, pub)
            } catch { return null }
        }
    }

    if (key) chatKeys.set(id, key)
    return key
}

/*
 * Почему ключа нет. Причин ровно три, и они требуют разных действий от
 * человека — общее «нет ключа» не даёт ему понять, что делать.
 */
export async function whyNoKey(chat) {
    if (!myPrivate) {
        return "Твой ключ не открыт. Выйди и войди заново, введя пароль"
    }
    if (chat.type === "dm") {
        const peer = chat.peer_id || (await otherMember(chat.chat_id || chat.id))
        if (peer && !(await publicKeyOf(peer))) {
            return "Собеседник ещё ни разу не заходил после включения шифрования — пусть войдёт, и переписка заработает"
        }
        return "Не удалось согласовать ключ с собеседником"
    }
    if (chat.key_created) {
        return "Ключ группы тебе ещё не передали. Попроси любого участника открыть чат — передача произойдёт сама"
    }
    return "У группы ещё нет ключа: его заводит создатель, когда впервые откроет чат"
}

async function otherMember(chatId) {
    const session = await currentSession()
    const { data } = await sb.from("chat_members")
        .select("user_id").eq("chat_id", chatId).neq("user_id", session.user.id).limit(1)
    return data && data[0] ? data[0].user_id : null
}

/** Создать ключ новой закрытой группы и завернуть его себе. */
export async function initGroupKey(chatId) {
    if (!myPrivate || !myPublicJwk) return null
    const session = await currentSession()
    const key = await cr.newGroupKey()
    const wrapped = await cr.wrapGroupKey(key, myPrivate, myPublicJwk)

    unwrap(await sb.from("chat_keys").insert({
        chat_id: chatId, user_id: session.user.id,
        wrapped_by: session.user.id, wrapped
    }))
    unwrap(await sb.from("chats").update({ key_created: true }).eq("id", chatId))

    chatKeys.set(chatId, key)
    return key
}

/**
 * Раздать ключ тем участникам, у кого его ещё нет.
 * Вызывается у того, кто ключ уже имеет: сервер раздать не может — у него
 * ключа нет и быть не должно.
 */
export async function shareKeyWithNewcomers(chat) {
    if (!myPrivate || !chat || chat.type === "dm" || !chat.encrypted) return 0
    const id = chat.chat_id || chat.id
    const key = await chatKey(chat)
    if (!key) return 0

    const { data: pending } = await sb.rpc("members_without_key", { _chat: id })
    if (!pending || !pending.length) return 0

    const session = await currentSession()
    const rows = []
    for (const person of pending) {
        try {
            rows.push({
                chat_id: id,
                user_id: person.id,
                wrapped_by: session.user.id,
                wrapped: await cr.wrapGroupKey(key, myPrivate, person.public_key)
            })
        } catch { /* у кого-то битый открытый ключ — пропускаем его одного */ }
    }
    if (!rows.length) return 0

    // Мог успеть кто-то другой: конфликт по первичному ключу здесь норма
    await sb.from("chat_keys").upsert(rows, { onConflict: "chat_id,user_id", ignoreDuplicates: true })
    return rows.length
}

/*
 * Почты при регистрации не спрашиваем намеренно.
 *
 * Единственное, зачем она была нужна, — восстановление пароля, а его здесь
 * не будет: канал восстановления это вторая дверь в аккаунт, и открыть её
 * может не только хозяин. При сквозном шифровании он вдобавок бесполезен —
 * ключ выведен из пароля, и сброс пароля переписку всё равно не вернёт.
 *
 * Значит почта — данные, которые незачем хранить: пользы ноль, а утечь
 * они могут. Мессенджер, обещающий анонимность, не собирает лишнего.
 */
export async function register({ username, password }) {
    if (!CFG.USERNAME_RE.test(username)) {
        throw new Error("Ник: латиница, цифры и подчёркивание, от 3 до 32 символов")
    }

    // Проверка «свободен ли» — вежливость, а не защита: между проверкой и
    // созданием кто-то может успеть занять ник. Настоящую гарантию даёт
    // уникальный индекс в базе, чью ошибку мы ловим ниже.
    if (!(await usernameFree(username))) {
        throw new Error("Такой ник уже занят")
    }

    const { data, error } = await sb.auth.signUp({
        email: authEmail(username),
        password,
        options: {
            data: {
                username,
                display_name: username
            }
        }
    })
    if (error) throw new Error(humanError(error))

    // Подтверждение почты выключено, поэтому сессия приходит сразу.
    // Если её вдруг нет — входим обычным путём.
    if (!data.session) await login({ username, password })

    // Пара ключей заводится сразу и только здесь: пароль есть на руках
    // ровно в этот момент и больше нигде не появится.
    const session = await currentSession()
    if (session) await createKeysFor(session.user.id, password)

    return data
}

export async function login({ username, password }) {
    const { data, error } = await sb.auth.signInWithPassword({
        email: authEmail(username),
        password
    })
    if (error) throw new Error(humanError(error))

    // Пароль нужен, чтобы расшифровать закрытый ключ. Другого случая
    // его узнать у нас не будет — дальше живём на сохранённой сессии.
    try {
        await loadKeys(password)
    } catch (e) {
        // Вход состоялся; без ключа не видно переписки, но не входа
        console.warn("ключи не открылись:", e.message)
    }
    return data
}

export async function logout() {
    dropKeys()
    await sb.auth.signOut()
}

/*
 * Стереть аккаунт. Насовсем.
 *
 * Всё, что можно стереть, стирает сама база (см. db/07_delete.sql); здесь
 * остаётся убрать следы с этого устройства — ключ расшифровки и сессию.
 * Порядок важен: пока не выполнено удаление на сервере, локальные ключи
 * трогать нельзя, иначе при обрыве связи человек останется с живым
 * аккаунтом, но без возможности прочитать собственную переписку.
 */
export async function deleteAccount() {
    unwrap(await sb.rpc("delete_account"))
    forgetBlobs()
    dropKeys()
    await sb.auth.signOut().catch(() => { /* аккаунта уже нет, ошибка не важна */ })
}

export async function currentSession() {
    const { data } = await sb.auth.getSession()
    return data.session || null
}

export async function myProfile() {
    const session = await currentSession()
    if (!session) return null
    const { data, error } = await sb
        .from("profiles").select("*").eq("id", session.user.id).single()
    if (error) return null
    return data
}

export async function updateProfile(patch) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")
    return unwrap(await sb.from("profiles")
        .update(patch).eq("id", session.user.id).select().single())
}

/* ============================================================================
   ЧАТЫ
   ============================================================================ */

export async function chatOverview() {
    const rows = unwrap(await sb.rpc("chat_overview")) || []

    /* Предпросмотр расшифровывается здесь, а не на сервере — у него ключа
       нет. Ошибка на одном чате не должна ронять весь список, поэтому
       каждый разбирается отдельно. */
    for (const row of rows) {
        if (!row.last_enc) continue
        try {
            const key = await chatKey(row)
            row.last_body = key ? await cr.decryptText(key, row.last_enc) : null
        } catch {
            row.last_body = null
        }
    }
    return rows
}

export async function chatById(id) {
    return unwrap(await sb.from("chats").select("*").eq("id", id).single())
}

export async function chatPeople(chatId) {
    return unwrap(await sb.rpc("chat_people", { _chat: chatId })) || []
}

export async function startDm(userId) {
    return unwrap(await sb.rpc("start_dm", { _other: userId }))
}

export async function createChat({ type, title, username, description, isPublic }) {
    return unwrap(await sb.rpc("create_chat", {
        _type: type,
        _title: title,
        _username: username || null,
        _description: description || null,
        _is_public: !!isPublic
    }))
}

export async function joinChat(chatId, invite = null) {
    return unwrap(await sb.rpc("join_chat", { _chat: chatId, _invite: invite }))
}

export async function leaveChat(chatId) {
    const session = await currentSession()
    return unwrap(await sb.from("chat_members").delete()
        .eq("chat_id", chatId).eq("user_id", session.user.id))
}

export async function deleteChat(chatId) {
    return unwrap(await sb.from("chats").delete().eq("id", chatId))
}

export async function setChatTtl(chatId, seconds) {
    return unwrap(await sb.rpc("set_chat_ttl", { _chat: chatId, _seconds: seconds || 0 }))
}

export async function setMuted(chatId, muted) {
    const session = await currentSession()
    return unwrap(await sb.from("chat_members")
        .update({ muted })
        .eq("chat_id", chatId).eq("user_id", session.user.id))
}

export async function markRead(chatId) {
    // Отметка о прочтении — не то, ради чего стоит показывать ошибку:
    // не дошла, значит счётчик обновится в следующий раз.
    try { await sb.rpc("mark_read", { _chat: chatId }) } catch { /* пусто */ }
}

export async function touchPresence() {
    try { await sb.rpc("touch_presence") } catch { /* пусто */ }
}

/* ============================================================================
   ПОИСК
   ============================================================================ */

export async function searchUsers(q) {
    if (!q) return []
    return unwrap(await sb.rpc("search_users", { _q: q })) || []
}

export async function resolveUsername(name) {
    const rows = unwrap(await sb.rpc("resolve_username", { _name: name })) || []
    return rows[0] || null
}

export async function publicChats(q) {
    return unwrap(await sb.from("chats")
        .select("id, type, title, username, avatar_url, description")
        .eq("is_public", true)
        .ilike("username", q + "%")
        .limit(20)) || []
}

/* ============================================================================
   СООБЩЕНИЯ
   ============================================================================ */

const MSG_FIELDS =
    "id, chat_id, sender_id, body, enc, media, reply_to, view_once, forwarded_from, created_at, edited_at, expires_at, deleted"

/*
 * Расшифровка ленты. Открытый текст в body остаётся у публичных каналов и
 * у сообщений, написанных до включения шифрования, — их просто пропускаем.
 *
 * Если ключа нет, сообщение не исчезает: вместо текста человек видит
 * честное «нечем расшифровать». Молчаливо пустой пузырь выглядел бы как
 * потеря сообщения.
 */
async function decryptRows(rows, chat) {
    const key = await chatKey(chat)
    for (const m of rows) {
        if (!m.enc) continue
        if (!key) { m.body = "🔒 Нечем расшифровать"; m.undecryptable = true; continue }
        const text = await cr.decryptText(key, m.enc)
        if (text === null) { m.body = "🔒 Не расшифровалось"; m.undecryptable = true }
        else m.body = text
    }
    return rows
}

/**
 * Страница сообщений. Тянем от новых к старым (before — курсор по времени),
 * а отдаём в обратном порядке, потому что рисуются они сверху вниз.
 */
export async function loadMessages(chat, before = null) {
    const chatId = chat.chat_id || chat.id || chat
    let q = sb.from("messages").select(MSG_FIELDS)
        .eq("chat_id", chatId)
        .eq("deleted", false)
        .order("created_at", { ascending: false })
        .limit(CFG.PAGE_SIZE)

    if (before) q = q.lt("created_at", before)

    const rows = unwrap(await q) || []
    const now = Date.now()
    const live = rows
        // просроченное могло ещё не дойти до уборки на сервере —
        // показывать его нельзя ни секунды
        .filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now)
        .reverse()

    return decryptRows(live, chat)
}

/** Расшифровать одно сообщение, пришедшее живым обновлением. */
export async function decryptIncoming(row, chat) {
    const [one] = await decryptRows([row], chat)
    return one
}

export async function loadMessage(id) {
    const { data, error } = await sb.from("messages").select(MSG_FIELDS).eq("id", id).single()
    if (error) return null
    return data
}

export async function sendMessage({ chat, body, media, replyTo, viewOnce, forwardedFrom }) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")
    const chatId = chat.chat_id || chat.id

    const row = {
        chat_id: chatId,
        sender_id: session.user.id,
        body: body || null,
        media: media && media.length ? media : null,
        reply_to: replyTo || null,
        view_once: !!viewOnce,
        forwarded_from: forwardedFrom || null
    }

    if (chat.encrypted && body) {
        const key = await chatKey(chat)
        if (!key) throw new Error(await whyNoKey(chat))
        row.enc = await cr.encryptText(key, body)
        // Открытый текст в базу не уходит: ради этого всё и затевалось
        row.body = null
    }

    const saved = unwrap(await sb.from("messages").insert(row).select(MSG_FIELDS).single())
    // Себе показываем то, что написали, а не шифротекст
    if (row.enc) saved.body = body
    return saved
}

export async function editMessage(id, body, chat) {
    const patch = { body, enc: null, edited_at: new Date().toISOString() }

    if (chat && chat.encrypted) {
        const key = await chatKey(chat)
        if (!key) throw new Error(await whyNoKey(chat))
        patch.enc = await cr.encryptText(key, body)
        patch.body = null
    }

    const saved = unwrap(await sb.from("messages")
        .update(patch).eq("id", id).select(MSG_FIELDS).single())
    if (patch.enc) saved.body = body
    return saved
}

export async function deleteMessage(id) {
    return unwrap(await sb.from("messages").delete().eq("id", id))
}

export async function burnMessage(id) {
    return unwrap(await sb.rpc("burn_message", { _msg: id }))
}

/*
 * Пересылка. Содержимое шифруется ЗАНОВО ключом чата-получателя: у каждого
 * чата свой ключ, и просто скопировать старый шифротекст нельзя — на той
 * стороне его нечем открыть.
 *
 * Отсюда же следует ограничение: переслать можно только то, что ты сам
 * можешь прочитать. Расшифровать чужое, не имея ключа, не выйдет.
 */
export async function forwardMessage(msg, fromChat, toChat, authorName) {
    if (msg.undecryptable) throw new Error("Это сообщение не расшифровано — переслать нечего")

    return sendMessage({
        chat: toChat,
        body: msg.body || null,
        // вложения лежат в хранилище зашифрованными ключом исходного чата,
        // поэтому пересылаются только вместе с текстом-описанием
        media: msg.media && !msg.media.some((m) => m.iv) ? msg.media : null,
        forwardedFrom: authorName
    })
}

/* ============================================================================
   РЕАКЦИИ
   ============================================================================ */

export async function loadReactions(ids) {
    if (!ids || !ids.length) return new Map()
    const rows = unwrap(await sb.rpc("reactions_for", { _ids: ids })) || []

    const byMessage = new Map()
    for (const r of rows) {
        if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, [])
        byMessage.get(r.message_id).push({ emoji: r.emoji, n: r.n, mine: r.mine })
    }
    return byMessage
}

export async function toggleReaction(messageId, emoji, mine) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")

    if (mine) {
        return unwrap(await sb.from("reactions").delete()
            .eq("message_id", messageId).eq("user_id", session.user.id).eq("emoji", emoji))
    }
    return unwrap(await sb.from("reactions")
        .insert({ message_id: messageId, user_id: session.user.id, emoji }))
}

/* ============================================================================
   БЛОКИРОВКИ
   ============================================================================ */

export async function blockUser(userId) {
    return unwrap(await sb.rpc("block_user", { _user: userId }))
}

export async function unblockUser(userId) {
    return unwrap(await sb.rpc("unblock_user", { _user: userId }))
}

export async function myBlocks() {
    return unwrap(await sb.rpc("my_blocks")) || []
}

export async function isBlockedByMe(userId) {
    const { data, error } = await sb.rpc("is_blocked_by_me", { _user: userId })
    if (error) return false
    return data === true
}

/* ============================================================================
   ФАЙЛЫ
   ============================================================================ */

export function mediaUrl(path) {
    return sb.storage.from("media").getPublicUrl(path).data.publicUrl
}

/*
 * Ссылка, которую можно поставить в <img src>. Для незашифрованного чата это
 * прямой адрес в хранилище, для зашифрованного — файл скачивается, тут же
 * расшифровывается и превращается в локальную ссылку blob:. В хранилище при
 * этом лежит нечитаемый набор байт.
 *
 * Расшифрованное держим в кэше: одна и та же картинка попадается и в ленте,
 * и в полноэкранном просмотре, а расшифровка видео на телефоне не бесплатна.
 */
const blobUrls = new Map()

export async function mediaSrc(item, chat) {
    if (!item.iv) return mediaUrl(item.path)

    if (blobUrls.has(item.path)) return blobUrls.get(item.path)

    const key = await chatKey(chat)
    if (!key) throw new Error("🔒 Нечем расшифровать")

    const { data, error } = await sb.storage.from("media").download(item.path)
    if (error) throw new Error(humanError(error))

    // тип нужен обязательно: без него браузер не поймёт, что за blob,
    // и не станет ни показывать картинку, ни проигрывать звук
    const mime = item.mime ||
        (item.type === "video" ? "video/mp4" : item.type === "audio" ? "audio/webm" : "image/jpeg")
    const plain = await cr.decryptBlob(key, await data.arrayBuffer(), item.iv, mime)
    const url = URL.createObjectURL(plain)
    blobUrls.set(item.path, url)
    return url
}

/** Освободить память под расшифрованными файлами при выходе. */
export function forgetBlobs() {
    for (const url of blobUrls.values()) URL.revokeObjectURL(url)
    blobUrls.clear()
}

/*
 * Фото ужимается до отправки. Причина простая: снимок с телефона весит
 * 4-8 МБ, а бесплатное хранилище — гигабайт на весь мессенджер. Сотня
 * неужатых фотографий съела бы его целиком. Полторы тысячи пикселей по
 * длинной стороне на экране телефона не отличаются от исходника.
 */
async function shrinkImage(file, maxSide = 1600, quality = 0.82) {
    if (!file.type.startsWith("image/")) return { blob: file, w: 0, h: 0 }
    // Анимацию GIF пережимать нельзя — от неё останется первый кадр
    if (file.type === "image/gif") return { blob: file, w: 0, h: 0 }

    const bitmap = await createImageBitmap(file).catch(() => null)
    if (!bitmap) return { blob: file, w: 0, h: 0 }

    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)

    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality))
    // Пережатие может выйти тяжелее исходника (маленький PNG-скриншот) —
    // тогда исходник и отправляем
    if (!blob || blob.size >= file.size) {
        return { blob: file, w, h }
    }
    return { blob, w, h }
}

/*
 * Аватарка: обрезаем по центру в квадрат и ужимаем до 256 пикселей.
 *
 * Именно обрезаем, а не вписываем: кружок всё равно покажет квадрат
 * по центру, и если картинку просто сжать, портрет растянет в блин.
 * 256 хватает с запасом — самый крупный кружок в интерфейсе 68 пикселей,
 * даже на экране с тройной плотностью это 204.
 */
async function squareAvatar(file) {
    const bitmap = await createImageBitmap(file).catch(() => null)
    if (!bitmap) throw new Error("Не удалось прочитать картинку")

    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2

    const size = 256
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    canvas.getContext("2d").drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
    bitmap.close()

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.86))
    if (!blob) throw new Error("Не удалось обработать картинку")
    return blob
}

/** Путь в хранилище из публичной ссылки — чтобы убрать старый файл. */
function pathFromPublicUrl(url) {
    if (!url) return null
    const marker = "/storage/v1/object/public/media/"
    const i = url.indexOf(marker)
    return i < 0 ? null : url.slice(i + marker.length)
}

/*
 * Аватарки НЕ шифруются, и это осознанно: профиль виден всем вошедшим, его
 * находят поиском по нику. Шифровать то, что и так показывают каждому, —
 * бессмысленная работа, которая ещё и сломала бы отрисовку списка чатов.
 */
export async function uploadAvatar(file, oldUrl = null) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")
    if (!file.type.startsWith("image/")) throw new Error("Нужна картинка")

    const blob = await squareAvatar(file)
    const path = `${session.user.id}/avatar-${crypto.randomUUID()}.jpg`

    const { error } = await sb.storage.from("media").upload(path, blob, {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: false
    })
    if (error) throw new Error(humanError(error))

    // Старую убираем сразу: хранилища всего гигабайт, а аватарку меняют часто
    const old = pathFromPublicUrl(oldUrl)
    if (old) await sb.storage.from("media").remove([old]).catch(() => {})

    return mediaUrl(path)
}

/** Фото группы или канала. Ставит только владелец или администратор. */
export async function setChatAvatar(chatId, file, oldUrl = null) {
    const url = await uploadAvatar(file, oldUrl)
    unwrap(await sb.from("chats").update({ avatar_url: url }).eq("id", chatId))
    return url
}

export async function clearChatAvatar(chatId, oldUrl = null) {
    unwrap(await sb.from("chats").update({ avatar_url: null }).eq("id", chatId))
    const old = pathFromPublicUrl(oldUrl)
    if (old) await sb.storage.from("media").remove([old]).catch(() => {})
}

/** Снять аватарку профиля вместе с файлом. */
export async function clearAvatarFile(oldUrl) {
    const old = pathFromPublicUrl(oldUrl)
    if (old) await sb.storage.from("media").remove([old]).catch(() => {})
}

/** Размеры видео нужны заранее, иначе лента дёргается при подгрузке. */
function videoSize(file) {
    return new Promise((resolve) => {
        const v = document.createElement("video")
        v.preload = "metadata"
        v.muted = true
        const url = URL.createObjectURL(file)
        const done = (w, h) => {
            URL.revokeObjectURL(url)
            resolve({ w, h })
        }
        v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight)
        v.onerror = () => done(0, 0)
        v.src = url
    })
}

/*
 * Голосовое. Отдельно от uploadMedia: там картинку жмут и меряют, а здесь
 * блоб уже готов и мерить нечего — важна только длительность, которую
 * посчитал сам рекордер.
 */
export async function uploadVoice(blob, { seconds, mime, chat = null } = {}) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")

    let body = blob
    let iv = null
    if (chat && chat.encrypted) {
        const key = await chatKey(chat)
        if (!key) throw new Error(await whyNoKey(chat))
        const sealed = await cr.encryptBlob(key, blob)
        body = sealed.blob
        iv = sealed.iv
    }

    const path = `${session.user.id}/${crypto.randomUUID()}.${iv ? "bin" : "webm"}`
    const { error } = await sb.storage.from("media").upload(path, body, {
        contentType: iv ? "application/octet-stream" : (mime || "audio/webm"),
        cacheControl: "31536000",
        upsert: false
    })
    if (error) throw new Error(humanError(error))

    return { path, type: "audio", dur: seconds, size: body.size, iv, mime: mime || "audio/webm" }
}

export async function uploadMedia(file, { spoiler = false, chat = null } = {}) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")

    const isVideo = file.type.startsWith("video/")
    const isImage = file.type.startsWith("image/")
    /* Всё, что не картинка и не видео, — просто файл: документ, архив,
       песня. Такому нечего ужимать и незачем мерить в пикселях, он едет
       как есть. */
    const isFile = !isVideo && !isImage

    if (isVideo && file.size > CFG.MAX_VIDEO_BYTES) {
        throw new Error("Видео тяжелее 50 МБ — сожми или обрежь")
    }
    if (isFile && file.size > CFG.MAX_FILE_BYTES) {
        throw new Error("Файл тяжелее 50 МБ")
    }
    if (isImage && file.size > CFG.MAX_IMAGE_BYTES) {
        throw new Error("Файл слишком тяжёлый")
    }

    let blob = file, w = 0, h = 0
    if (isVideo) {
        ({ w, h } = await videoSize(file))
    } else if (isImage) {
        ({ blob, w, h } = await shrinkImage(file))
    }

    const mime = blob.type || file.type || "application/octet-stream"
    const own = (file.name.split(".").pop() || "").toLowerCase()
    let ext
    if (isVideo) ext = own || "mp4"
    else if (isFile) ext = own || "bin"
    else ext = blob === file ? (own || "jpg") : "jpg"

    // Шифруем ПЕРЕД отправкой: в хранилище не должно попасть ничего читаемого
    let iv = null
    if (chat && chat.encrypted) {
        const key = await chatKey(chat)
        if (!key) throw new Error(await whyNoKey(chat))
        const sealed = await cr.encryptBlob(key, blob)
        blob = sealed.blob
        iv = sealed.iv
        // расширение скрывает тип содержимого, да и файл больше не картинка
        ext = "bin"
    }

    // Папка обязана называться id пользователя — так требует правило хранилища
    const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`

    const { error } = await sb.storage.from("media").upload(path, blob, {
        contentType: iv ? "application/octet-stream" : mime,
        cacheControl: "31536000",
        upsert: false
    })
    if (error) throw new Error(humanError(error))

    /* mime сохраняем в описании: после шифрования его больше неоткуда взять.
       Имя — только у файлов: у картинки оно ни к чему, а вот «договор.pdf»
       без имени превращается в загадку. */
    const item = { path, type: isVideo ? "video" : (isFile ? "file" : "image"),
                   w, h, spoiler, size: blob.size, iv, mime }
    if (isFile) item.name = file.name || "файл"
    return item
}

/* ============================================================================
   ЖИВЫЕ ОБНОВЛЕНИЯ
   ============================================================================ */

/**
 * Подписка на один чат. Возвращает функцию отписки.
 * on = { insert, update, remove }
 */
export function watchChat(chatId, on) {
    const ch = sb.channel(`chat:${chatId}`)
        .on("postgres_changes",
            { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
            (p) => on.insert && on.insert(p.new))
        .on("postgres_changes",
            { event: "UPDATE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
            (p) => on.update && on.update(p.new))
        .on("postgres_changes",
            { event: "DELETE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
            (p) => on.remove && on.remove(p.old))
        /* Реакции фильтровать по чату нельзя — в таблице есть только id
           сообщения. Приходит всё, что видно по правилам доступа, а нужное
           отбирает уже клиент по списку загруженных сообщений. */
        .on("postgres_changes",
            { event: "*", schema: "public", table: "reactions" },
            (p) => {
                const id = (p.new && p.new.message_id) || (p.old && p.old.message_id)
                if (on.reaction) on.reaction(id)
            })
        .subscribe()

    return () => { sb.removeChannel(ch) }
}

/**
 * Подписка на «что-то поменялось вообще» — чтобы обновлять список чатов.
 * Фильтровать по своим чатам на стороне сервера нельзя (фильтр умеет только
 * равенство одному значению), поэтому фильтруем уже здесь, по известному
 * списку id.
 */
export function watchInbox(onChange) {
    const ch = sb.channel("inbox")
        .on("postgres_changes",
            { event: "*", schema: "public", table: "messages" },
            (p) => onChange((p.new && p.new.chat_id) || (p.old && p.old.chat_id)))
        .on("postgres_changes",
            { event: "*", schema: "public", table: "chat_members" },
            () => onChange(null))
        .subscribe()

    return () => { sb.removeChannel(ch) }
}

/** «Печатает...» — вещание без записи в базу, живёт только пока открыт чат. */
export function typingChannel(chatId, me, onTyping) {
    const ch = sb.channel(`typing:${chatId}`, { config: { broadcast: { self: false } } })
        .on("broadcast", { event: "typing" }, ({ payload }) => onTyping(payload))
        .subscribe()

    let last = 0
    return {
        ping() {
            // не чаще раза в две секунды: иначе каждое нажатие клавиши
            // превращается в сетевой пакет
            const now = Date.now()
            if (now - last < 2000) return
            last = now
            ch.send({ type: "broadcast", event: "typing", payload: { id: me.id, name: me.username } })
        },
        stop() { sb.removeChannel(ch) }
    }
}

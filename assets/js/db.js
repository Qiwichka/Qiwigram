/* db.js — всё общение с Supabase. Выше этого файла SQL и ключи не поднимаются. */

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
    cannot_dm_self: "Нельзя написать самому себе"
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

export async function register({ username, password, email }) {
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
                display_name: username,
                recovery_email: (email || "").trim()
            }
        }
    })
    if (error) throw new Error(humanError(error))

    // Подтверждение почты выключено, поэтому сессия приходит сразу.
    // Если её вдруг нет — входим обычным путём.
    if (!data.session) await login({ username, password })
    return data
}

export async function login({ username, password }) {
    const { data, error } = await sb.auth.signInWithPassword({
        email: authEmail(username),
        password
    })
    if (error) throw new Error(humanError(error))
    return data
}

export async function logout() {
    await sb.auth.signOut()
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
    return unwrap(await sb.rpc("chat_overview")) || []
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
    "id, chat_id, sender_id, body, media, reply_to, view_once, created_at, edited_at, expires_at, deleted"

/**
 * Страница сообщений. Тянем от новых к старым (before — курсор по времени),
 * а отдаём в обратном порядке, потому что рисуются они сверху вниз.
 */
export async function loadMessages(chatId, before = null) {
    let q = sb.from("messages").select(MSG_FIELDS)
        .eq("chat_id", chatId)
        .eq("deleted", false)
        .order("created_at", { ascending: false })
        .limit(CFG.PAGE_SIZE)

    if (before) q = q.lt("created_at", before)

    const rows = unwrap(await q) || []
    const now = Date.now()
    return rows
        // просроченное могло ещё не дойти до уборки на сервере —
        // показывать его нельзя ни секунды
        .filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now)
        .reverse()
}

export async function loadMessage(id) {
    const { data, error } = await sb.from("messages").select(MSG_FIELDS).eq("id", id).single()
    if (error) return null
    return data
}

export async function sendMessage({ chatId, body, media, replyTo, viewOnce }) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")

    return unwrap(await sb.from("messages").insert({
        chat_id: chatId,
        sender_id: session.user.id,
        body: body || null,
        media: media && media.length ? media : null,
        reply_to: replyTo || null,
        view_once: !!viewOnce
    }).select(MSG_FIELDS).single())
}

export async function editMessage(id, body) {
    return unwrap(await sb.from("messages")
        .update({ body, edited_at: new Date().toISOString() })
        .eq("id", id).select(MSG_FIELDS).single())
}

export async function deleteMessage(id) {
    return unwrap(await sb.from("messages").delete().eq("id", id))
}

export async function burnMessage(id) {
    return unwrap(await sb.rpc("burn_message", { _msg: id }))
}

/* ============================================================================
   ФАЙЛЫ
   ============================================================================ */

export function mediaUrl(path) {
    return sb.storage.from("media").getPublicUrl(path).data.publicUrl
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

export async function uploadMedia(file, { spoiler = false } = {}) {
    const session = await currentSession()
    if (!session) throw new Error("Не выполнен вход")

    const isVideo = file.type.startsWith("video/")
    if (isVideo && file.size > CFG.MAX_VIDEO_BYTES) {
        throw new Error("Видео тяжелее 50 МБ — сожми или обрежь")
    }
    if (!isVideo && file.size > CFG.MAX_IMAGE_BYTES) {
        throw new Error("Файл слишком тяжёлый")
    }

    let blob = file, w = 0, h = 0
    if (isVideo) {
        ({ w, h } = await videoSize(file))
    } else {
        ({ blob, w, h } = await shrinkImage(file))
    }

    const ext = isVideo ? (file.name.split(".").pop() || "mp4").toLowerCase()
                        : (blob === file ? (file.name.split(".").pop() || "jpg").toLowerCase() : "jpg")
    // Папка обязана называться id пользователя — так требует правило хранилища
    const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`

    const { error } = await sb.storage.from("media").upload(path, blob, {
        contentType: blob.type || file.type,
        cacheControl: "31536000",
        upsert: false
    })
    if (error) throw new Error(humanError(error))

    return { path, type: isVideo ? "video" : "image", w, h, spoiler, size: blob.size }
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

/*
 * watch.js — уведомления в приложении.
 *
 * Обычные push доставляет сервис Google: он будит приложение, даже когда
 * телефон спит. Зарегистрироваться в Firebase не вышло — там требуют
 * подтверждение по номеру телефона, — поэтому приложение сторожит переписку
 * само: держится в фоне и раз в полминуты спрашивает сервер, нет ли нового.
 *
 * Здесь только разговор с человеком и передача токенов. Вся работа — в
 * WatchService.java; там же объяснено, почему в уведомлении не бывает
 * текста сообщения (он зашифрован, ключа у сторожа нет и быть не должно).
 */

import * as db from "./db.js"
import { $, el, modal, toast } from "./ui.js"

const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Watch

/** Есть ли вообще о чём говорить: в браузере сторожа не бывает. */
export const watchAvailable = !!plugin

/**
 * Спросить при входе. Отказ запоминается только до следующего запуска:
 * человек мог отказаться, не поняв, о чём речь, а мессенджер без
 * уведомлений — это не мессенджер, и напомнить о них стоит.
 */
export async function offerWatch() {
    if (!plugin) return

    let state
    try {
        state = await plugin.status()
    } catch {
        return
    }

    // уже работает — только освежим токены, чтобы сторож не отвалился
    if (state.enabled) return pushTokens()

    const yes = await askDialog()
    if (!yes) {
        try { await plugin.decline() } catch { /* переживём */ }
        return
    }

    await enableWatch()
}

/** Включить сторожа: сначала системные разрешения, потом он сам. */
export async function enableWatch() {
    if (!plugin) return false

    try {
        // Системное окно про уведомления. Без разрешения сторож будет
        // работать вхолостую — показать ему будет нечего.
        await plugin.askNotifications()

        const session = await db.currentSession()
        if (!session) return false

        await plugin.start({
            url: window.QIWI.SUPABASE_URL,
            key: window.QIWI.SUPABASE_KEY,
            access: session.access_token,
            refresh: session.refresh_token
        })

        /* Второе системное окно — про батарею. Отдельно и после первого:
           два системных окна разом человек воспринимает как одно и
           закрывает не глядя. */
        await plugin.askBattery()

        toast("Уведомления включены")
        return true
    } catch (e) {
        toast("Не вышло включить уведомления", true)
        return false
    }
}

export async function disableWatch() {
    if (!plugin) return
    try {
        await plugin.stop()
        toast("Уведомления выключены")
    } catch { /* ничего страшного */ }
}

export async function watchStatus() {
    if (!plugin) return null
    try { return await plugin.status() } catch { return null }
}

/*
 * Токены живут около часа, а сторож — сутками. Он умеет обновлять их сам,
 * но пока приложение открыто, проще отдать ему свежие: у самого приложения
 * они всегда актуальные.
 */
export async function pushTokens() {
    if (!plugin) return
    try {
        const session = await db.currentSession()
        if (!session) return
        await plugin.refreshTokens({
            access: session.access_token,
            refresh: session.refresh_token
        })
    } catch { /* не критично, сторож обновит сам */ }
}

/* ------------------------------- разговор ------------------------------- */

/*
 * Объяснение до системного окна, а не вместо него.
 *
 * Android покажет свои окна сам, но они спрашивают «разрешить уведомления?»
 * и «не экономить батарею?» — без единого слова о том, зачем. На такие
 * вопросы вслепую отвечают «нет». Поэтому сначала честно рассказываем,
 * что будет, включая постоянную строчку в шторке: узнать о ней от нас
 * лучше, чем обнаружить её самому и решить, что приложение шпионит.
 */
function askDialog() {
    return modal((box, close) => {
        box.append(
            el("h2", { text: "Включить уведомления?" }),
            el("p", { class: "modal__sub" },
                "Сейчас о новом сообщении можно узнать, только открыв Qiwigram. " +
                "Чтобы они приходили сами, приложению нужно оставаться в фоне."),

            el("div", { class: "note" },
                el("div", { class: "note__title", text: "Что при этом будет" }),
                el("ul", { class: "note__list" },
                    el("li", { text: "В шторке появится постоянная строчка «Qiwigram следит за перепиской» — Android иначе не разрешает работать в фоне" }),
                    el("li", { text: "Батарея будет расходоваться немного быстрее" }),
                    el("li", { text: "В уведомлении видно, от кого сообщение, но не сам текст: переписка зашифрована, и прочитать её может только приложение" })
                )
            ),

            el("div", { class: "modal__actions" },
                el("button", { class: "btn btn--ghost", onclick: () => close(false) }, "Не надо"),
                el("button", { class: "btn btn--primary", onclick: () => close(true) }, "Включить")
            )
        )
    })
}

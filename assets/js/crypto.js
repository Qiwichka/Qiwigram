/*
 * crypto.js — сквозное шифрование Qiwigram.
 *
 * Всё считается в браузере через встроенный WebCrypto. Своей математики
 * здесь нет ни строчки, и это принципиально: самодельная криптография
 * ломается всегда, а браузерная реализация проверена тысячами глаз.
 *
 * УСТРОЙСТВО
 *
 *   При регистрации заводится пара ключей ECDH на кривой P-256. Открытый
 *   уезжает в профиль и виден всем — без него человеку нельзя написать.
 *   Закрытый шифруется ключом, выведенным из пароля через PBKDF2, и в таком
 *   виде кладётся в базу. Пароль на сервер не попадает никогда: Supabase
 *   хранит от него хеш, а ключ шифрования считается здесь, в браузере.
 *
 *   ЛИЧКА. Общий секрет выводится из «мой закрытый + его открытый».
 *   У собеседника из «его закрытый + мой открытый» получается ровно то же
 *   число — таково свойство ECDH. Никакого обмена ключами не нужно, на
 *   сервере этого числа нет и взяться ему там неоткуда.
 *
 *   ГРУППА. Двоих там нет, поэтому у чата собственный случайный ключ,
 *   завёрнутый отдельно под каждого участника — тем же парным секретом.
 *
 *   ФАЙЛЫ. Шифруются целиком перед отправкой, тем же ключом чата. В
 *   хранилище лежит нечитаемый набор байт, который расшифровывается уже
 *   в браузере получателя.
 *
 * ЧЕГО ЭТО НЕ ЗАКРЫВАЕТ — говорить вслух, а не прятать в примечаниях:
 *
 *   - метаданные: кто, кому, когда и сколько написал, видно по-прежнему
 *   - слабый пароль: закрытый ключ защищён им, и владелец базы может
 *     перебирать пароль сколько угодно, никто ему не помешает
 *   - подмену самого сайта: сегодня код такой, завтра владелец выложит
 *     другой. Против этого помогает только собранный APK и открытый код
 */

const te = new TextEncoder()
const td = new TextDecoder()

/* --------------------------- байты и строки --------------------------- */

function toB64(buf) {
    const bytes = new Uint8Array(buf)
    let s = ""
    // по кускам: на большом файле spread в String.fromCharCode
    // переполняет стек аргументов
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(s)
}

function fromB64(s) {
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))

/* ------------------------------ пара ключей ------------------------------ */

const ECDH = { name: "ECDH", namedCurve: "P-256" }

export async function generateKeyPair() {
    return crypto.subtle.generateKey(ECDH, true, ["deriveKey", "deriveBits"])
}

export async function exportPublic(pair) {
    return crypto.subtle.exportKey("jwk", pair.publicKey)
}

export async function exportPrivate(pair) {
    return crypto.subtle.exportKey("jwk", pair.privateKey)
}

export async function importPublic(jwk) {
    return crypto.subtle.importKey("jwk", jwk, ECDH, true, [])
}

export async function importPrivate(jwk) {
    return crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveKey", "deriveBits"])
}

/* --------------------- защита закрытого ключа паролем --------------------- */

/*
 * 310 000 повторений — та цифра, которую OWASP называет для PBKDF2-SHA256.
 * Смысл в том, чтобы перебор пароля по украденной базе стоил дорого.
 * На телефоне это примерно полсекунды — заметно, но происходит только
 * при входе, а не при каждом сообщении.
 */
const PBKDF2_ROUNDS = 310000

async function keyFromPassword(password, salt) {
    const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"])
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    )
}

/** Закрытый ключ -> { v, salt, iv, ct } для хранения в базе. */
export async function protectPrivateKey(privateJwk, password) {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const kek = await keyFromPassword(password, salt)
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, kek, te.encode(JSON.stringify(privateJwk))
    )
    return { v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) }
}

/** Обратно. Бросает, если пароль не тот — GCM проверяет целостность сам. */
export async function unlockPrivateKey(blob, password) {
    const kek = await keyFromPassword(password, fromB64(blob.salt))
    let plain
    try {
        plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromB64(blob.iv) }, kek, fromB64(blob.ct)
        )
    } catch {
        throw new Error("Неверный пароль — переписку не расшифровать")
    }
    return JSON.parse(td.decode(plain))
}

/* ---------------------------- общий секрет ---------------------------- */

/*
 * Из ECDH получаем сырые биты и прогоняем через HKDF, а не берём напрямую.
 * Сырой результат ECDH распределён неравномерно и ключом быть не должен;
 * HKDF выравнивает его и заодно привязывает к назначению через info.
 */
async function sharedKey(privateKey, publicKey, info) {
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"])
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
        hk,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
    )
}

/** Ключ переписки один на двоих: обе стороны получают одинаковый. */
export async function dmKey(myPrivate, theirPublicJwk) {
    return sharedKey(myPrivate, await importPublic(theirPublicJwk), "qiwigram-dm-v1")
}

/* ------------------------------- группы ------------------------------- */

export async function newGroupKey() {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
}

/** Завернуть ключ группы под конкретного участника. */
export async function wrapGroupKey(groupKey, myPrivate, theirPublicJwk) {
    const kek = await sharedKey(myPrivate, await importPublic(theirPublicJwk), "qiwigram-wrap-v1")
    const raw = await crypto.subtle.exportKey("raw", groupKey)
    const iv = randomBytes(12)
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw)
    return { v: 1, iv: toB64(iv), ct: toB64(ct) }
}

/** Развернуть присланный ключ группы. */
export async function unwrapGroupKey(blob, myPrivate, wrapperPublicJwk) {
    const kek = await sharedKey(myPrivate, await importPublic(wrapperPublicJwk), "qiwigram-wrap-v1")
    const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(blob.iv) }, kek, fromB64(blob.ct)
    )
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
}

/* ---------------------------- текст и файлы ---------------------------- */

export async function encryptText(key, text) {
    const iv = randomBytes(12)
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(text))
    return { v: 1, iv: toB64(iv), ct: toB64(ct) }
}

export async function decryptText(key, blob) {
    if (!blob || !blob.iv) return null
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.ct)
        )
        return td.decode(plain)
    } catch {
        // Не расшифровалось — чаще всего ключа для этого чата ещё нет.
        // Ронять всю ленту из-за одного сообщения нельзя.
        return null
    }
}

/** Файл целиком. Возвращает Blob для отправки и вектор для описания. */
export async function encryptBlob(key, file) {
    const iv = randomBytes(12)
    const buf = await file.arrayBuffer()
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf)
    return { blob: new Blob([ct], { type: "application/octet-stream" }), iv: toB64(iv) }
}

export async function decryptBlob(key, buffer, ivB64, mime) {
    const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(ivB64) }, key, buffer
    )
    return new Blob([plain], { type: mime || "application/octet-stream" })
}

/* ------------------------- хранение на устройстве ------------------------- */

/*
 * Расшифрованный закрытый ключ лежит рядом с токеном сессии, в localStorage
 * этого устройства. Иначе пароль пришлось бы спрашивать при каждом запуске,
 * а в приложении на телефоне это невыносимо.
 *
 * Размен честный: у того, кто получил доступ к разблокированному телефону,
 * и так есть открытая переписка на экране.
 */
const LS_KEY = "qiwi.privkey"

export function cachePrivateKey(jwk) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(jwk)) } catch { /* приватный режим */ }
}

export function readCachedPrivateKey() {
    try {
        const raw = localStorage.getItem(LS_KEY)
        return raw ? JSON.parse(raw) : null
    } catch { return null }
}

export function forgetPrivateKey() {
    try { localStorage.removeItem(LS_KEY) } catch { /* пусто */ }
}

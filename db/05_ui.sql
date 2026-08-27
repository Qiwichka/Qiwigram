-- ============================================================================
--  Qiwigram — предпросмотр зашифрованных чатов и галочки прочтения.
--  Запускать ПЯТЫМ, после четырёх предыдущих.
-- ============================================================================

/*
 * Список чатов пересобирается ещё раз, ради двух вещей.
 *
 * ПЕРВОЕ — предпросмотр. Сервер отдавать его не может: он не знает, что
 * написано, и это ровно то, чего мы добивались. Поэтому он отдаёт кусок
 * шифротекста как есть, а расшифровывает его браузер, у которого ключ
 * имеется. Снаружи выглядит как обычный список с текстом, при этом на
 * сервере по-прежнему нечего читать.
 *
 * ВТОРОЕ — галочки. Отдельной таблицы «кто что прочитал» заводить не нужно:
 * отметка о прочтении у каждого участника уже есть в chat_members. Если она
 * позже времени сообщения — значит собеседник до него добрался. Так две
 * галочки не стоят ни одной новой строки в базе.
 */

drop function if exists public.chat_overview();

create function public.chat_overview()
returns table (
    chat_id          uuid,
    type             text,
    title            text,
    username         text,
    avatar_url       text,
    is_public        boolean,
    encrypted        boolean,
    key_created      boolean,
    ttl_seconds      integer,
    last_message_at  timestamptz,
    my_role          text,
    last_read_at     timestamptz,
    muted            boolean,
    peer_id          uuid,
    peer_username    text,
    peer_name        text,
    peer_avatar      text,
    peer_last_seen   timestamptz,
    peer_read_at     timestamptz,
    last_body        text,
    last_enc         jsonb,
    last_sender_id   uuid,
    last_sender_name text,
    last_has_media   boolean,
    unread           integer
)
language sql stable security definer set search_path = public as $$
    select
        c.id, c.type, c.title, c.username, c.avatar_url, c.is_public,
        c.encrypted, c.key_created,
        c.ttl_seconds, c.last_message_at,
        m.role, m.last_read_at, m.muted,
        peer.id, peer.username, coalesce(peer.display_name, peer.username),
        peer.avatar_url, peer.last_seen, peer.read_at,
        -- открытый текст только там, где чат и так открыт
        case when c.encrypted then null else lm.body end,
        -- а здесь шифротекст: расшифрует браузер
        case when c.encrypted then lm.enc else null end,
        lm.sender_id, ls.username, (lm.media is not null),
        coalesce(un.n, 0)::int
    from chat_members m
    join chats c on c.id = m.chat_id
    left join lateral (
        select p.*, m2.last_read_at as read_at
        from chat_members m2
        join profiles p on p.id = m2.user_id
        where m2.chat_id = c.id and m2.user_id <> auth.uid() and c.type = 'dm'
        limit 1
    ) peer on true
    left join lateral (
        select x.body, x.enc, x.sender_id, x.media
        from messages x
        where x.chat_id = c.id and not x.deleted
          and (x.expires_at is null or x.expires_at > now())
        order by x.created_at desc
        limit 1
    ) lm on true
    left join profiles ls on ls.id = lm.sender_id
    left join lateral (
        select count(*) as n
        from messages x
        where x.chat_id = c.id
          and x.created_at > m.last_read_at
          and x.sender_id <> auth.uid()
          and not x.deleted
          and (x.expires_at is null or x.expires_at > now())
    ) un on true
    where m.user_id = auth.uid()
    order by c.last_message_at desc;
$$;

grant execute on function public.chat_overview() to authenticated;

/* Отметка о прочтении должна долетать до собеседника сама, иначе вторая
   галочка появится только после того, как он что-нибудь напишет. */
do $$
begin
    begin
        execute 'alter table public.chat_members replica identity full';
    exception when others then null;
    end;
end $$;

-- ============================================================================
--  Qiwigram — вторая часть схемы: запросы, которые вызывает браузер.
--  Запускать ПОСЛЕ schema.sql. Тоже идемпотентно.
-- ============================================================================

/*
 * Список чатов одним запросом.
 *
 * Собирать его в браузере по частям — «мои чаты», потом «последнее сообщение
 * в каждом», потом «сколько непрочитанных» — значит на двадцати чатах сделать
 * шестьдесят обращений к базе. На телефоне по мобильному интернету список
 * открывался бы секундами. Здесь всё считается за один проход.
 */
create or replace function public.chat_overview()
returns table (
    chat_id          uuid,
    type             text,
    title            text,
    username         text,
    avatar_url       text,
    is_public        boolean,
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
    last_body        text,
    last_sender_id   uuid,
    last_sender_name text,
    last_has_media   boolean,
    unread           integer
)
language sql stable security definer set search_path = public as $$
    select
        c.id, c.type, c.title, c.username, c.avatar_url, c.is_public,
        c.ttl_seconds, c.last_message_at,
        m.role, m.last_read_at, m.muted,
        peer.id, peer.username, coalesce(peer.display_name, peer.username),
        peer.avatar_url, peer.last_seen,
        lm.body, lm.sender_id, ls.username, (lm.media is not null),
        coalesce(un.n, 0)::int
    from chat_members m
    join chats c on c.id = m.chat_id
    -- собеседник в личке; для групп и каналов остаётся пустым
    left join lateral (
        select p.*
        from chat_members m2
        join profiles p on p.id = m2.user_id
        where m2.chat_id = c.id and m2.user_id <> auth.uid() and c.type = 'dm'
        limit 1
    ) peer on true
    -- последнее живое сообщение
    left join lateral (
        select x.body, x.sender_id, x.media
        from messages x
        where x.chat_id = c.id and not x.deleted
          and (x.expires_at is null or x.expires_at > now())
        order by x.created_at desc
        limit 1
    ) lm on true
    left join profiles ls on ls.id = lm.sender_id
    -- непрочитанные: чужие, после отметки о прочтении, ещё не сгоревшие
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

create or replace function public.mark_read(_chat uuid)
returns void language sql security definer set search_path = public as $$
    update chat_members set last_read_at = now()
    where chat_id = _chat and user_id = auth.uid();
$$;

create or replace function public.touch_presence()
returns void language sql security definer set search_path = public as $$
    update profiles set last_seen = now() where id = auth.uid();
$$;

/* Таймер самоуничтожения. В личке его ставит любой из двоих — это общий
   договор двух людей. В группе и канале только владелец и админы. */
create or replace function public.set_chat_ttl(_chat uuid, _seconds integer)
returns void language plpgsql security definer set search_path = public as $$
declare
    t text;
begin
    if not public.is_chat_member(_chat) then raise exception 'not_member'; end if;
    select type into t from chats where id = _chat;
    if t <> 'dm' and public.chat_role(_chat) not in ('owner', 'admin') then
        raise exception 'not_admin';
    end if;
    update chats set ttl_seconds = nullif(_seconds, 0) where id = _chat;
end $$;

/* «Просмотр один раз»: получатель открыл вложение — и оно стирается.
   Стирается сразу для всех, а не лично для смотрящего: иначе в группе
   вложение осталось бы жить у остальных, и обещание «один раз» было бы
   ложью. Отправитель своё вложение не сжигает — он и так знает, что там. */
create or replace function public.burn_message(_msg uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    m messages%rowtype;
begin
    select * into m from messages where id = _msg;
    if not found or not m.view_once then return; end if;
    if not public.can_read_chat(m.chat_id) then raise exception 'no_access'; end if;
    if m.sender_id = auth.uid() then return; end if;

    insert into message_views (message_id, user_id)
    values (_msg, auth.uid()) on conflict do nothing;

    update messages set media = null where id = _msg;
end $$;

/* Участники чата вместе с профилями — для окна «о чате». */
create or replace function public.chat_people(_chat uuid)
returns table (id uuid, username text, display_name text, avatar_url text,
               role text, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, coalesce(p.display_name, p.username),
           p.avatar_url, m.role, p.last_seen
    from chat_members m
    join profiles p on p.id = m.user_id
    where m.chat_id = _chat and public.can_read_chat(_chat)
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
             p.username
    limit 200;
$$;

grant execute on function public.chat_overview()                  to authenticated;
grant execute on function public.mark_read(uuid)                  to authenticated;
grant execute on function public.touch_presence()                 to authenticated;
grant execute on function public.set_chat_ttl(uuid, integer)      to authenticated;
grant execute on function public.burn_message(uuid)               to authenticated;
grant execute on function public.chat_people(uuid)                to authenticated;

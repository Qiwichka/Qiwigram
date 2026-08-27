-- ============================================================================
--  Qiwigram — сквозное шифрование.
--  Запускать ЧЕТВЁРТЫМ, после трёх предыдущих файлов.
--
--  Смысл всего, что ниже: на сервере не остаётся ничего, чем можно прочитать
--  переписку. Здесь лежат только открытые ключи (они на то и открытые) и
--  закрытые ключи, зашифрованные паролем пользователя — пароль в базу
--  не попадает никогда, его знает только сам человек.
-- ============================================================================

-- Открытый ключ виден всем вошедшим: без него нельзя написать человеку.
alter table public.profiles
    add column if not exists public_key jsonb;

/* Закрытый ключ, зашифрованный ключом, выведенным из пароля владельца.
   Лежит в закрытой таблице и никому, кроме владельца, не отдаётся — но даже
   если бы отдавался, без пароля это просто мусор. */
alter table public.user_private
    add column if not exists private_key_enc jsonb;

/* Зашифрованное тело сообщения: { v, iv, ct }.
   Старое поле body остаётся для публичных каналов и для сообщений,
   написанных до включения шифрования. */
alter table public.messages
    add column if not exists enc jsonb;

/* Признак «этот чат шифруется». Нужен клиенту, чтобы не пытаться
   расшифровать публичный канал и не отправить открытый текст в личку. */
alter table public.chats
    add column if not exists encrypted boolean not null default false;

/* Заведён ли уже ключ у этой группы.
   Без такого признака новичок не может отличить «ключа ещё ни у кого нет,
   я первый» от «ключ есть, просто мне его пока не завернули» — свою строку
   в chat_keys каждый видит, а чужие нет. Ошибись он, и группа развалится
   на две половины с разными ключами. */
alter table public.chats
    add column if not exists key_created boolean not null default false;

-- Личка шифруется всегда, закрытые группы и каналы — тоже.
update public.chats
   set encrypted = true
 where encrypted = false
   and (type = 'dm' or is_public = false);

/* Ключ группы, завёрнутый лично для каждого участника.
   В личке такой таблицы не нужно: там общий ключ выводится из пары
   «мой закрытый + его открытый» и совпадает у обеих сторон сам собой.
   В группе так не выйдет — участников больше двух, поэтому у чата есть
   собственный ключ, и его заворачивают отдельно под каждого. */
create table if not exists public.chat_keys (
    chat_id    uuid not null references public.chats(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    -- чьим открытым ключом заворачивали: без этого получатель не знает,
    -- с кем считать общий секрет, чтобы развернуть
    wrapped_by uuid not null references public.profiles(id) on delete cascade,
    wrapped    jsonb not null,
    created_at timestamptz not null default now(),
    primary key (chat_id, user_id)
);

alter table public.chat_keys enable row level security;

drop policy if exists chat_keys_read on public.chat_keys;
create policy chat_keys_read on public.chat_keys
    for select to authenticated using (user_id = auth.uid());

/* Завернуть ключ для другого участника может любой, кто сам в этом чате
   состоит — иначе новичок, вошедший по ссылке, остался бы без ключа
   до тех пор, пока не появится администратор. */
drop policy if exists chat_keys_write on public.chat_keys;
create policy chat_keys_write on public.chat_keys
    for insert to authenticated
    with check (public.is_chat_member(chat_id) and wrapped_by = auth.uid());

/* Кому из участников ключ ещё не завернули. По этому списку клиент того,
   у кого ключ есть, раздаёт его остальным. */
create or replace function public.members_without_key(_chat uuid)
returns table (id uuid, username text, public_key jsonb)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, p.public_key
    from chat_members m
    join profiles p on p.id = m.user_id
    where m.chat_id = _chat
      and public.is_chat_member(_chat)
      and p.public_key is not null
      and not exists (
          select 1 from chat_keys k
          where k.chat_id = _chat and k.user_id = m.user_id
      )
    limit 200;
$$;

grant execute on function public.members_without_key(uuid) to authenticated;

/* Открытый ключ собеседника. Отдельной функцией, чтобы не тащить весь
   профиль ради одного поля. */
create or replace function public.public_key_of(_user uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
    select public_key from profiles where id = _user;
$$;

grant execute on function public.public_key_of(uuid) to authenticated;

-- ============================================================================
--  Список чатов пересобирается: клиенту нужно знать, шифруется ли чат,
--  иначе он не поймёт, чем расшифровывать ленту и чем шифровать отправку.
-- ============================================================================

/* Сначала удалить, потом создать заново: у функции меняется набор
   возвращаемых полей (добавились encrypted и key_created), а такое
   «create or replace» в Postgres запрещено. */
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
    last_body        text,
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
        peer.avatar_url, peer.last_seen,
        -- у зашифрованного чата предпросмотра нет и быть не может: сервер
        -- сам не знает, что там написано. Ровно этого мы и добивались.
        case when c.encrypted then null else lm.body end,
        lm.sender_id, ls.username, (lm.media is not null),
        coalesce(un.n, 0)::int
    from chat_members m
    join chats c on c.id = m.chat_id
    left join lateral (
        select p.*
        from chat_members m2
        join profiles p on p.id = m2.user_id
        where m2.chat_id = c.id and m2.user_id <> auth.uid() and c.type = 'dm'
        limit 1
    ) peer on true
    left join lateral (
        select x.body, x.sender_id, x.media
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

-- Новая личка и новые закрытые чаты должны сразу помечаться шифрованными.
create or replace function public.mark_encrypted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.type = 'dm' or new.is_public = false then
        new.encrypted := true;
    end if;
    return new;
end $$;

drop trigger if exists chats_mark_encrypted on public.chats;
create trigger chats_mark_encrypted
    before insert on public.chats
    for each row execute function public.mark_encrypted();

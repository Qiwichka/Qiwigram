-- ============================================================================
--  Qiwigram — схема базы
--  Выполнять целиком в SQL Editor проекта Supabase. Скрипт идемпотентный:
--  повторный запуск ничего не ломает и не стирает данные.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
--  ТАБЛИЦЫ
-- ============================================================================

-- ---------------------------------------------------------------- профили ---
create table if not exists public.profiles (
    id           uuid primary key references auth.users(id) on delete cascade,
    username     text not null check (username ~ '^[A-Za-z0-9_]{3,32}$'),
    display_name text,
    bio          text,
    avatar_url   text,
    created_at   timestamptz not null default now(),
    last_seen    timestamptz not null default now()
);

-- Ник уникален без учёта регистра: «Kiwi» и «kiwi» — один и тот же адрес,
-- иначе на этом строится подделка под чужой аккаунт.
create unique index if not exists profiles_username_key
    on public.profiles (lower(username));

-- Настоящая почта лежит ОТДЕЛЬНО от профиля намеренно. Профили видны всем
-- вошедшим (иначе никого не найти по нику), а RLS умеет закрывать только
-- строки целиком, не отдельные колонки. Держи почта в profiles — её читал бы
-- каждый вместе с ником.
create table if not exists public.user_private (
    id             uuid primary key references auth.users(id) on delete cascade,
    recovery_email text,
    created_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------- чаты -----
create table if not exists public.chats (
    id              uuid primary key default gen_random_uuid(),
    type            text not null check (type in ('dm', 'group', 'channel')),
    title           text,
    username        text check (username ~ '^[A-Za-z0-9_]{3,32}$'),
    description     text,
    avatar_url      text,
    owner_id        uuid references public.profiles(id) on delete set null,
    is_public       boolean not null default false,
    -- таймер самоуничтожения для всего чата, в секундах; null — выключен
    ttl_seconds     integer check (ttl_seconds is null or ttl_seconds > 0),
    invite_code     text unique default encode(gen_random_bytes(9), 'hex'),
    -- пара собеседников для лички: два id, отсортированных и склеенных.
    -- Уникальность по нему не даёт завести второй диалог с тем же человеком.
    dm_key          text unique,
    created_at      timestamptz not null default now(),
    last_message_at timestamptz not null default now()
);

create unique index if not exists chats_username_key
    on public.chats (lower(username)) where username is not null;

create index if not exists chats_last_message_idx
    on public.chats (last_message_at desc);

-- ------------------------------------------------------------- участники ----
create table if not exists public.chat_members (
    chat_id      uuid not null references public.chats(id) on delete cascade,
    user_id      uuid not null references public.profiles(id) on delete cascade,
    role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
    joined_at    timestamptz not null default now(),
    last_read_at timestamptz not null default now(),
    muted        boolean not null default false,
    primary key (chat_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members (user_id);

-- -------------------------------------------------------------- сообщения ---
create table if not exists public.messages (
    id         uuid primary key default gen_random_uuid(),
    chat_id    uuid not null references public.chats(id) on delete cascade,
    sender_id  uuid references public.profiles(id) on delete set null,
    body       text,
    -- [{ path, type: 'image'|'video', w, h, spoiler: bool, size }]
    media      jsonb,
    reply_to   uuid references public.messages(id) on delete set null,
    -- «просмотр один раз»: получатель открыл — и вложение пропало
    view_once  boolean not null default false,
    created_at timestamptz not null default now(),
    edited_at  timestamptz,
    -- момент самоуничтожения, проставляется из chats.ttl_seconds
    expires_at timestamptz,
    deleted    boolean not null default false
);

create index if not exists messages_chat_created_idx
    on public.messages (chat_id, created_at desc);

create index if not exists messages_expires_idx
    on public.messages (expires_at) where expires_at is not null;

-- Realtime по умолчанию присылает в событиях удаления и правки только
-- первичный ключ. Для «сообщение исчезло из чата N» этого мало — нужен
-- chat_id, чтобы понять, в каком окне его гасить.
alter table public.messages replica identity full;

-- ------------------------------------------------------- кто что посмотрел --
create table if not exists public.message_views (
    message_id uuid not null references public.messages(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    viewed_at  timestamptz not null default now(),
    primary key (message_id, user_id)
);

-- ============================================================================
--  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
--
--  Все они security definer, и это не небрежность, а необходимость.
--  Правило доступа к chat_members, которое само читает chat_members, уходит
--  в бесконечную рекурсию и роняет запрос. Функция с security definer
--  выполняется в обход RLS и разрывает петлю.
--
--  search_path прибит гвоздями у каждой: без него владелец схемы может
--  подсунуть свою таблицу вместо нашей и функция выполнит чужой код.
-- ============================================================================

create or replace function public.is_chat_member(_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from chat_members
        where chat_id = _chat and user_id = auth.uid()
    );
$$;

create or replace function public.chat_role(_chat uuid)
returns text language sql stable security definer set search_path = public as $$
    select role from chat_members
    where chat_id = _chat and user_id = auth.uid();
$$;

/* Читать можно свой чат, а также любой публичный канал или группу —
   на то они и публичные, их открывают по ссылке ещё до вступления. */
create or replace function public.can_read_chat(_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from chats c
        where c.id = _chat
          and (c.is_public or exists (
                select 1 from chat_members m
                where m.chat_id = c.id and m.user_id = auth.uid()
          ))
    );
$$;

/* Писать может участник. В канале — только владелец и админы:
   канал на то и канал, что это вещание, а не разговор. */
create or replace function public.can_post_chat(_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from chats c
        join chat_members m on m.chat_id = c.id and m.user_id = auth.uid()
        where c.id = _chat
          and (c.type <> 'channel' or m.role in ('owner', 'admin'))
    );
$$;

/* Ник един для людей и для чатов: @kiwi не может быть одновременно
   человеком и каналом, иначе ссылка перестаёт быть однозначной. */
create or replace function public.username_taken(_name text)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where lower(username) = lower(_name))
        or exists (select 1 from chats    where lower(username) = lower(_name));
$$;

/* Публичная проверка для формы регистрации: отдаёт только «да/нет»,
   ничего о владельце ника не рассказывает. */
create or replace function public.username_available(_name text)
returns boolean language sql stable security definer set search_path = public as $$
    select _name ~ '^[A-Za-z0-9_]{3,32}$' and not public.username_taken(_name);
$$;

grant execute on function public.username_available(text) to anon, authenticated;

-- --------------------------------------------- сквозная проверка ников ------

create or replace function public.check_profile_username()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if tg_op = 'UPDATE' and lower(new.username) = lower(old.username) then
        return new;
    end if;
    if exists (select 1 from chats where lower(username) = lower(new.username)) then
        raise exception 'username_taken' using errcode = '23505';
    end if;
    return new;
end $$;

drop trigger if exists profiles_username_guard on public.profiles;
create trigger profiles_username_guard
    before insert or update of username on public.profiles
    for each row execute function public.check_profile_username();

create or replace function public.check_chat_username()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if new.username is null then
        return new;
    end if;
    if tg_op = 'UPDATE' and old.username is not null
       and lower(new.username) = lower(old.username) then
        return new;
    end if;
    if exists (select 1 from profiles where lower(username) = lower(new.username)) then
        raise exception 'username_taken' using errcode = '23505';
    end if;
    return new;
end $$;

drop trigger if exists chats_username_guard on public.chats;
create trigger chats_username_guard
    before insert or update of username on public.chats
    for each row execute function public.check_chat_username();

-- ------------------------------------------- профиль при регистрации --------

/* Профиль заводится триггером на самой auth.users, а не запросом из браузера.
   Иначе между «создали аккаунт» и «создали профиль» есть щель, в которую
   попадает любой обрыв связи — и человек остаётся с аккаунтом без ника. */
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    uname text := new.raw_user_meta_data ->> 'username';
begin
    if uname is null then
        raise exception 'username_required';
    end if;

    insert into public.profiles (id, username, display_name)
    values (new.id, uname, coalesce(new.raw_user_meta_data ->> 'display_name', uname));

    insert into public.user_private (id, recovery_email)
    values (new.id, nullif(new.raw_user_meta_data ->> 'recovery_email', ''));

    return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ------------------------------------------------ таймер самоуничтожения ----

create or replace function public.apply_message_ttl()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    ttl integer;
begin
    select ttl_seconds into ttl from chats where id = new.chat_id;
    if ttl is not null then
        new.expires_at := now() + make_interval(secs => ttl);
    end if;
    return new;
end $$;

drop trigger if exists messages_ttl on public.messages;
create trigger messages_ttl
    before insert on public.messages
    for each row execute function public.apply_message_ttl();

create or replace function public.bump_chat()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update chats set last_message_at = new.created_at where id = new.chat_id;
    return new;
end $$;

drop trigger if exists messages_bump_chat on public.messages;
create trigger messages_bump_chat
    after insert on public.messages
    for each row execute function public.bump_chat();

-- ============================================================================
--  RPC — то, что браузер вызывает напрямую
-- ============================================================================

/* Открыть личку. Возвращает id существующего диалога или заводит новый.
   Пара считается по отсортированным id, поэтому «я к тебе» и «ты ко мне» —
   это один и тот же чат, а не два параллельных. */
create or replace function public.start_dm(_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    me   uuid := auth.uid();
    key  text;
    cid  uuid;
begin
    if me is null then raise exception 'not_authenticated'; end if;
    if _other = me then raise exception 'cannot_dm_self'; end if;
    if not exists (select 1 from profiles where id = _other) then
        raise exception 'no_such_user';
    end if;

    key := least(me::text, _other::text) || ':' || greatest(me::text, _other::text);

    select id into cid from chats where dm_key = key;
    if cid is not null then
        -- собеседник мог выйти из диалога — возвращаем его обратно
        insert into chat_members (chat_id, user_id)
        values (cid, me), (cid, _other)
        on conflict do nothing;
        return cid;
    end if;

    insert into chats (type, dm_key, owner_id) values ('dm', key, me) returning id into cid;
    insert into chat_members (chat_id, user_id, role)
    values (cid, me, 'owner'), (cid, _other, 'member');

    return cid;
end $$;

/* Создать группу или канал вместе с собой в роли владельца — одним куском,
   чтобы не осталось чата без единого участника, если связь оборвётся. */
create or replace function public.create_chat(
    _type text, _title text, _username text default null,
    _description text default null, _is_public boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare
    me  uuid := auth.uid();
    cid uuid;
begin
    if me is null then raise exception 'not_authenticated'; end if;
    if _type not in ('group', 'channel') then raise exception 'bad_type'; end if;
    if _username is not null and public.username_taken(_username) then
        raise exception 'username_taken' using errcode = '23505';
    end if;

    insert into chats (type, title, username, description, is_public, owner_id)
    values (_type, _title, nullif(_username, ''), _description, _is_public, me)
    returning id into cid;

    insert into chat_members (chat_id, user_id, role) values (cid, me, 'owner');
    return cid;
end $$;

/* Вступление по ссылке. Публичный чат пускает всех, закрытый — только по
   приглашению с кодом. */
create or replace function public.join_chat(_chat uuid, _invite text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
    me uuid := auth.uid();
    c  chats%rowtype;
begin
    if me is null then raise exception 'not_authenticated'; end if;
    select * into c from chats where id = _chat;
    if not found then raise exception 'no_such_chat'; end if;
    if c.type = 'dm' then raise exception 'cannot_join_dm'; end if;

    if not c.is_public and (_invite is null or _invite <> c.invite_code) then
        raise exception 'invite_required';
    end if;

    insert into chat_members (chat_id, user_id) values (_chat, me)
    on conflict do nothing;
    return true;
end $$;

/* Поиск по нику. Отдаёт только публичные поля — почта сюда не попадает
   в принципе, она в другой таблице. */
create or replace function public.search_users(_q text)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, p.display_name, p.avatar_url
    from profiles p
    where p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
      and p.username ilike _q || '%'
    order by length(p.username), p.username
    limit 20;
$$;

create or replace function public.resolve_username(_name text)
returns table (kind text, id uuid, username text, title text, avatar_url text)
language sql stable security definer set search_path = public as $$
    select 'user', p.id, p.username, coalesce(p.display_name, p.username), p.avatar_url
    from profiles p where lower(p.username) = lower(_name)
    union all
    select c.type, c.id, c.username, c.title, c.avatar_url
    from chats c where lower(c.username) = lower(_name) and c.is_public;
$$;

grant execute on function public.start_dm(uuid)                                    to authenticated;
grant execute on function public.create_chat(text, text, text, text, boolean)      to authenticated;
grant execute on function public.join_chat(uuid, text)                             to authenticated;
grant execute on function public.search_users(text)                                to authenticated;
grant execute on function public.resolve_username(text)                            to authenticated;

-- ============================================================================
--  ПРАВИЛА ДОСТУПА (RLS)
--  Без единой политики таблица заперта наглухо. Ниже открывается ровно то,
--  что нужно, и ни байтом больше.
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.user_private  enable row level security;
alter table public.chats         enable row level security;
alter table public.chat_members  enable row level security;
alter table public.messages      enable row level security;
alter table public.message_views enable row level security;

-- ------------------------------------------------------------- профили -----
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
    for select to authenticated using (true);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
    for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- --------------------------------------------------- закрытые данные -------
drop policy if exists private_self on public.user_private;
create policy private_self on public.user_private
    for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- --------------------------------------------------------------- чаты ------
drop policy if exists chats_read on public.chats;
create policy chats_read on public.chats
    for select to authenticated using (is_public or public.is_chat_member(id));

drop policy if exists chats_update_admin on public.chats;
create policy chats_update_admin on public.chats
    for update to authenticated
    using (public.chat_role(id) in ('owner', 'admin'))
    with check (public.chat_role(id) in ('owner', 'admin'));

drop policy if exists chats_delete_owner on public.chats;
create policy chats_delete_owner on public.chats
    for delete to authenticated using (public.chat_role(id) = 'owner');

-- Прямая вставка чата закрыта: заводить их можно только через create_chat
-- и start_dm, иначе появится чат, в котором нет ни одного участника.

-- --------------------------------------------------------- участники ------
drop policy if exists members_read on public.chat_members;
create policy members_read on public.chat_members
    for select to authenticated using (public.can_read_chat(chat_id));

drop policy if exists members_leave on public.chat_members;
create policy members_leave on public.chat_members
    for delete to authenticated
    using (user_id = auth.uid() or public.chat_role(chat_id) in ('owner', 'admin'));

drop policy if exists members_update on public.chat_members;
create policy members_update on public.chat_members
    for update to authenticated
    using (user_id = auth.uid() or public.chat_role(chat_id) in ('owner', 'admin'))
    with check (true);

drop policy if exists members_add on public.chat_members;
create policy members_add on public.chat_members
    for insert to authenticated
    with check (public.chat_role(chat_id) in ('owner', 'admin'));

-- -------------------------------------------------------- сообщения -------
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
    for select to authenticated using (public.can_read_chat(chat_id));

drop policy if exists messages_send on public.messages;
create policy messages_send on public.messages
    for insert to authenticated
    with check (sender_id = auth.uid() and public.can_post_chat(chat_id));

drop policy if exists messages_edit on public.messages;
create policy messages_edit on public.messages
    for update to authenticated
    using (sender_id = auth.uid()) with check (sender_id = auth.uid());

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages
    for delete to authenticated
    using (sender_id = auth.uid() or public.chat_role(chat_id) in ('owner', 'admin'));

-- --------------------------------------------------------- просмотры ------
drop policy if exists views_own on public.message_views;
create policy views_own on public.message_views
    for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Хранилище файлов вынесено в 03_storage.sql: правки таблиц storage требуют
-- особых прав, а SQL Editor выполняет скрипт одной транзакцией — упрись
-- хранилище в права, и откатилась бы вся схема целиком.

-- ============================================================================
--  REALTIME — какие таблицы вещают изменения в браузер
-- ============================================================================

do $$
begin
    begin execute 'alter publication supabase_realtime add table public.messages';      exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.chats';         exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.chat_members';  exception when duplicate_object then null; end;
end $$;

-- ============================================================================
--  УБОРКА ПРОСРОЧЕННОГО
--  Клиент и так не показывает сообщения с истёкшим сроком, но из базы их
--  надо реально стирать — иначе «самоуничтожение» это только слово.
-- ============================================================================

create or replace function public.purge_expired()
returns void language sql security definer set search_path = public as $$
    delete from messages where expires_at is not null and expires_at < now();
$$;

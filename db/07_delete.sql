-- ============================================================================
--  Qiwigram — удаление аккаунта.
--  Запускать ПОСЛЕ 06_social.sql. Идемпотентно, как и остальные части.
-- ============================================================================

/*
 * Удалённый аккаунт остаётся строкой в profiles, и это не недоделка.
 *
 * Строка держит за собой ник. Убери её — и ник освободится, а значит завтра
 * его займёт кто угодно и получит переписку, где отправителем подписан
 * прежний владелец. Для мессенджера, где человека узнают только по нику,
 * это подмена личности, и защиты от неё не будет никакой.
 *
 * Поэтому от аккаунта остаётся ровно надгробие: ник, дата удаления и больше
 * ничего. Имя, описание, аватар и открытый ключ стираются, настоящая почта
 * удаляется совсем, вход закрывается навсегда.
 */

alter table public.profiles
    add column if not exists deleted_at timestamptz;

-- Ник удалённого занят навсегда, но в поиске такому человеку делать нечего
create index if not exists profiles_alive_idx
    on public.profiles (id) where deleted_at is null;

-- ------------------------------------------------------------------ удаление

create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public, auth as $$
declare
    me uuid := auth.uid();
begin
    if me is null then
        raise exception 'not_authenticated';
    end if;

    /* Профиль остаётся, но пустой. Ник не трогаем — он и есть надгробие,
       из-за которого всё это делается именно так. */
    update public.profiles
       set display_name = null,
           bio          = null,
           avatar_url   = null,
           public_key   = null,
           deleted_at   = now()
     where id = me;

    -- Настоящая почта — единственное, что связывало аккаунт с человеком
    delete from public.user_private where id = me;

    /* Из групп и каналов выходим: числиться участником больше некому.
       Личку не трогаем — иначе у собеседника переписка оборвётся на
       полуслове, а он в удалении аккаунта не участвовал. */
    delete from public.chat_members m
     using public.chats c
     where m.user_id = me
       and m.chat_id = c.id
       and c.type <> 'dm';

    -- Ключи от чатов расшифровывать больше некому
    delete from public.chat_keys where user_id = me;

    /* Вход закрываем навсегда.
       Строку из auth.users НЕ удаляем: у profiles на неё ссылка с каскадом,
       и удаление утащило бы за собой профиль вместе с ником — ровно то,
       чего эта функция должна не допустить. */
    update auth.users
       set banned_until = 'infinity'::timestamptz
     where id = me;
end $$;

grant execute on function public.delete_account() to authenticated;

-- ------------------------------------------- признак удаления в запросах ----

/*
 * Дальше — те же функции, что и раньше, с одной добавленной колонкой:
 * собеседник (или участник) может оказаться удалённым, и интерфейс обязан
 * показать это вместо «был в сети час назад». Иначе выходит, что человек
 * просто давно не заходил, и его ждут.
 *
 * Обе сначала удаляются, а не заменяются на месте: `create or replace`
 * умеет менять тело функции, но не список колонок, которые она отдаёт,
 * и на добавленной колонке падает с «cannot change return type».
 * Права выдаются заново ниже — вместе с функцией пропадают и они.
 */

drop function if exists public.chat_overview();
drop function if exists public.chat_people(uuid);

/*
 * ВНИМАНИЕ ТОМУ, КТО БУДЕТ ПРАВИТЬ ЭТУ ФУНКЦИЮ ДАЛЬШЕ.
 *
 * Она объявлена не только здесь: первая версия лежит в 02_overview.sql,
 * рабочая — в 05_ui.sql, и каждый следующий файл переопределяет её целиком.
 * Значит брать за основу надо САМОЕ ПОЗДНЕЕ объявление, а не первое
 * попавшееся, иначе колонки, добавленные в промежутке, тихо исчезнут.
 *
 * Именно так однажды и вышло: за основу взяли версию из 02_overview.sql,
 * и чаты потеряли `encrypted`, `key_created`, `last_enc` и `peer_read_at` —
 * то есть всё, по чему браузер понимает, что чат зашифрован и чем его
 * расшифровывать. Снаружи это выглядело как «переписку нечем открыть».
 *
 * Здесь основа — версия из 05_ui.sql, к ней добавлена одна колонка.
 */
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
    peer_deleted     boolean,
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
        (peer.deleted_at is not null),
        -- открытый текст только там, где чат и так открыт
        case when c.encrypted then null else lm.body end,
        -- а здесь шифротекст: расшифрует браузер
        case when c.encrypted then lm.enc else null end,
        lm.sender_id, ls.username, (lm.media is not null),
        coalesce(un.n, 0)::int
    from chat_members m
    join chats c on c.id = m.chat_id
    -- собеседник в личке; для групп и каналов остаётся пустым
    left join lateral (
        select p.*, m2.last_read_at as read_at
        from chat_members m2
        join profiles p on p.id = m2.user_id
        where m2.chat_id = c.id and m2.user_id <> auth.uid() and c.type = 'dm'
        limit 1
    ) peer on true
    -- последнее живое сообщение
    left join lateral (
        select x.body, x.enc, x.sender_id, x.media
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

create function public.chat_people(_chat uuid)
returns table (id uuid, username text, display_name text, avatar_url text,
               role text, last_seen timestamptz, deleted boolean)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, coalesce(p.display_name, p.username),
           p.avatar_url, m.role, p.last_seen, (p.deleted_at is not null)
    from chat_members m
    join profiles p on p.id = m.user_id
    where m.chat_id = _chat and public.can_read_chat(_chat)
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
             p.username
    limit 200;
$$;

grant execute on function public.chat_overview()   to authenticated;
grant execute on function public.chat_people(uuid) to authenticated;

-- ------------------------------------------------------------------- поиск --

/*
 * Удалённых в поиске быть не должно: писать им некому. Ник при этом
 * остаётся занятым — он просто больше никого не находит, и завести
 * его заново тоже нельзя.
 *
 * Обе функции — те же, что в schema.sql, с одним добавленным условием.
 */

create or replace function public.search_users(_q text)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, p.display_name, p.avatar_url
    from profiles p
    where p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
      and p.deleted_at is null
      and p.username ilike _q || '%'
    order by length(p.username), p.username
    limit 20;
$$;

create or replace function public.resolve_username(_name text)
returns table (kind text, id uuid, username text, title text, avatar_url text)
language sql stable security definer set search_path = public as $$
    select 'user', p.id, p.username, coalesce(p.display_name, p.username), p.avatar_url
    from profiles p where lower(p.username) = lower(_name) and p.deleted_at is null
    union all
    select c.type, c.id, c.username, c.title, c.avatar_url
    from chats c where lower(c.username) = lower(_name) and c.is_public;
$$;

grant execute on function public.search_users(text)     to authenticated;
grant execute on function public.resolve_username(text) to authenticated;

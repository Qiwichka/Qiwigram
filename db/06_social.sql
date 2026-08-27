-- ============================================================================
--  Qiwigram — блокировки, реакции, пересылка.
--  Запускать ШЕСТЫМ, после пяти предыдущих.
-- ============================================================================

-- ---------------------------------------------------------- блокировки -----

/*
 * Заблокированный не может написать в личку. Проверка живёт в базе, а не в
 * интерфейсе: спрятать кнопку мало — тот, кто захочет, отправит запрос
 * напрямую. Блокировка, которую можно обойти, блокировкой не является.
 */
create table if not exists public.blocks (
    blocker    uuid not null references public.profiles(id) on delete cascade,
    blocked    uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker, blocked),
    check (blocker <> blocked)
);

alter table public.blocks enable row level security;

/* Свой список видит только сам блокирующий. Знать, что тебя заблокировали,
   человеку не положено — иначе это превращается в способ проверять,
   кто как к тебе относится. */
drop policy if exists blocks_own on public.blocks;
create policy blocks_own on public.blocks
    for all to authenticated
    using (blocker = auth.uid()) with check (blocker = auth.uid());

create or replace function public.blocked_between(_a uuid, _b uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from blocks
        where (blocker = _a and blocked = _b)
           or (blocker = _b and blocked = _a)
    );
$$;

/* Писать может участник; в канал — только владелец и админы;
   в личку — только если между собеседниками нет блокировки. */
create or replace function public.can_post_chat(_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from chats c
        join chat_members m on m.chat_id = c.id and m.user_id = auth.uid()
        where c.id = _chat
          and (c.type <> 'channel' or m.role in ('owner', 'admin'))
          and (
            c.type <> 'dm'
            or not exists (
                select 1
                from chat_members other
                where other.chat_id = c.id
                  and other.user_id <> auth.uid()
                  and public.blocked_between(auth.uid(), other.user_id)
            )
          )
    );
$$;

/* Начать личку с тем, кто тебя заблокировал, тоже нельзя — иначе в списке
   чатов появится диалог, в который невозможно написать. */
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
    if public.blocked_between(me, _other) then
        raise exception 'blocked';
    end if;

    key := least(me::text, _other::text) || ':' || greatest(me::text, _other::text);

    select id into cid from chats where dm_key = key;
    if cid is not null then
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

create or replace function public.block_user(_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'not_authenticated'; end if;
    if _user = auth.uid() then raise exception 'cannot_block_self'; end if;
    insert into blocks (blocker, blocked) values (auth.uid(), _user)
    on conflict do nothing;
end $$;

create or replace function public.unblock_user(_user uuid)
returns void language sql security definer set search_path = public as $$
    delete from blocks where blocker = auth.uid() and blocked = _user;
$$;

create or replace function public.my_blocks()
returns table (id uuid, username text, display_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, coalesce(p.display_name, p.username), p.avatar_url
    from blocks b join profiles p on p.id = b.blocked
    where b.blocker = auth.uid()
    order by p.username;
$$;

/* Заблокирован ли конкретный человек — для кнопки в интерфейсе. */
create or replace function public.is_blocked_by_me(_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from blocks where blocker = auth.uid() and blocked = _user);
$$;

grant execute on function public.block_user(uuid)      to authenticated;
grant execute on function public.unblock_user(uuid)    to authenticated;
grant execute on function public.my_blocks()           to authenticated;
grant execute on function public.is_blocked_by_me(uuid) to authenticated;

-- ------------------------------------------------------------- реакции -----

create table if not exists public.reactions (
    message_id uuid not null references public.messages(id) on delete cascade,
    user_id    uuid not null references public.profiles(id) on delete cascade,
    emoji      text not null check (length(emoji) between 1 and 16),
    created_at timestamptz not null default now(),
    primary key (message_id, user_id, emoji)
);

create index if not exists reactions_message_idx on public.reactions (message_id);

alter table public.reactions enable row level security;
alter table public.reactions replica identity full;

/* Реакция видна тем же, кому видно само сообщение. Чат берём отдельной
   функцией: правило не может само лезть в messages, там своё правило,
   и получилась бы вложенная проверка на каждую строку. */
create or replace function public.message_chat(_msg uuid)
returns uuid language sql stable security definer set search_path = public as $$
    select chat_id from messages where id = _msg;
$$;

drop policy if exists reactions_read on public.reactions;
create policy reactions_read on public.reactions
    for select to authenticated
    using (public.can_read_chat(public.message_chat(message_id)));

drop policy if exists reactions_add on public.reactions;
create policy reactions_add on public.reactions
    for insert to authenticated
    with check (user_id = auth.uid()
                and public.can_read_chat(public.message_chat(message_id)));

drop policy if exists reactions_remove on public.reactions;
create policy reactions_remove on public.reactions
    for delete to authenticated using (user_id = auth.uid());

/* Реакции к пачке сообщений одним запросом — по одному на сообщение
   было бы полсотни обращений на каждый экран переписки. */
create or replace function public.reactions_for(_ids uuid[])
returns table (message_id uuid, emoji text, n integer, mine boolean)
language sql stable security definer set search_path = public as $$
    select r.message_id, r.emoji, count(*)::int,
           bool_or(r.user_id = auth.uid())
    from reactions r
    where r.message_id = any(_ids)
      and public.can_read_chat(public.message_chat(r.message_id))
    group by r.message_id, r.emoji
    order by r.message_id, min(r.created_at);
$$;

grant execute on function public.reactions_for(uuid[]) to authenticated;

-- ----------------------------------------------------------- пересылка -----

/* Имя исходного автора. Само содержимое при пересылке шифруется заново
   ключом чата, куда пересылают: у того чата свой ключ, и старый шифротекст
   там прочитать было бы нечем. */
alter table public.messages
    add column if not exists forwarded_from text;

-- ------------------------------------------------------------- realtime ----

do $$
begin
    begin execute 'alter publication supabase_realtime add table public.reactions';
    exception when duplicate_object then null; end;
end $$;

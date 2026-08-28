-- ============================================================================
--  Qiwigram — админ.
--  Запускать ПОСЛЕ 07_delete.sql. Идемпотентно.
-- ============================================================================

/*
 * Права админа живут здесь, а не в коде приложения, и это единственное,
 * что делает их правами.
 *
 * Код открыт: любой может склонировать репозиторий, запустить у себя и
 * подправить в браузере что угодно — публичный ключ Supabase лежит прямо
 * в config.js, он и должен там лежать. Нарисовать себе админские кнопки
 * не мешает ничто. Но кнопки ничего не решают: каждое действие проверяется
 * заново здесь, на сервере, куда чужой рукой не дотянуться.
 *
 * Поэтому список админов — отдельная таблица, а не колонка в profiles.
 * RLS в Postgres работает построчно: закрыть одну колонку в строке, которую
 * человек и так имеет право править, сложно и легко ошибиться. Закрыть
 * отдельную таблицу целиком — просто и надёжно.
 */

create table if not exists public.admins (
    id      uuid primary key references public.profiles(id) on delete cascade,
    -- подпись рядом с именем: «создатель», «модератор» и так далее
    title   text not null default 'создатель',
    since   timestamptz not null default now()
);

alter table public.admins enable row level security;

/*
 * Политика ровно одна — на чтение. Ни INSERT, ни UPDATE, ни DELETE не
 * описаны намеренно: при включённом RLS отсутствие политики означает
 * запрет для всех. Выдать себе админку из браузера нельзя ничем.
 *
 * Единственный путь внутрь — SQL Editor в панели Supabase, куда пускают
 * по паролю от аккаунта владельца.
 */
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins
    for select to authenticated using (true);

create or replace function public.is_admin(_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from admins where id = _user);
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- ------------------------------------------------------------- подписи ----

/*
 * Кто у нас админ и как подписан. Отдаётся всем: подпись «создатель» рядом
 * с ником для того и нужна, чтобы её видели остальные.
 *
 * Отдельной функцией, а не колонкой в chat_overview, намеренно: та функция
 * объявлена уже в трёх файлах подряд, и каждое лишнее её переопределение —
 * повод потерять колонку, добавленную в предыдущем. Админов единицы,
 * список забирается один раз при запуске и лежит в памяти.
 */
create or replace function public.admin_titles()
returns table (id uuid, title text)
language sql stable security definer set search_path = public as $$
    select a.id, a.title from admins a;
$$;

grant execute on function public.admin_titles() to authenticated;

-- ------------------------------------------------------ удаление аккаунта --

/*
 * Общая часть удаления — чтобы «удалил сам» и «удалил админ» стирали
 * ровно одно и то же. Разъедься эти два списка хоть на одну таблицу,
 * и один из способов однажды оставит после себя хвост.
 *
 * Наружу не отдаётся: вызывать её может только код внутри базы.
 */
create or replace function public.wipe_account(_id uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
begin
    update public.profiles
       set display_name = null,
           bio          = null,
           avatar_url   = null,
           public_key   = null,
           deleted_at   = now()
     where id = _id;

    delete from public.user_private where id = _id;

    delete from public.chat_members m
     using public.chats c
     where m.user_id = _id
       and m.chat_id = c.id
       and c.type <> 'dm';

    delete from public.chat_keys where user_id = _id;

    update auth.users
       set banned_until = 'infinity'::timestamptz
     where id = _id;
end $$;

revoke all on function public.wipe_account(uuid) from public, anon, authenticated;

-- Своё удаление теперь тоже идёт через общую часть
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then
        raise exception 'not_authenticated';
    end if;
    perform public.wipe_account(auth.uid());
end $$;

grant execute on function public.delete_account() to authenticated;

/*
 * Удаление чужого аккаунта.
 *
 * Два запрета кроме проверки прав. Себя через админку не удаляют — для
 * этого есть обычная кнопка с минутой ожидания, и промахнуться ею сложнее.
 * Другого админа не удаляют вовсе: иначе двое с правами могут снести друг
 * друга, и разбираться, кто был первым, придётся уже по логам базы.
 */
create or replace function public.admin_delete_account(_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then
        raise exception 'not_admin';
    end if;
    if _user = auth.uid() then
        raise exception 'self_delete';
    end if;
    if public.is_admin(_user) then
        raise exception 'target_is_admin';
    end if;
    if not exists (select 1 from profiles where id = _user and deleted_at is null) then
        raise exception 'no_such_user';
    end if;

    perform public.wipe_account(_user);
end $$;

grant execute on function public.admin_delete_account(uuid) to authenticated;

/*
 * Поиск для админки — по точному нику, включая уже удалённых: админу надо
 * видеть и то, что аккаунт стёрт, иначе непонятно, сработала кнопка или нет.
 * Обычный поиск удалённых не показывает и показывать не должен.
 */
create or replace function public.admin_find(_name text)
returns table (id uuid, username text, display_name text, avatar_url text,
               created_at timestamptz, deleted boolean, admin boolean)
language sql stable security definer set search_path = public as $$
    select p.id, p.username, p.display_name, p.avatar_url, p.created_at,
           (p.deleted_at is not null), public.is_admin(p.id)
    from profiles p
    where public.is_admin() and lower(p.username) = lower(_name);
$$;

grant execute on function public.admin_find(text) to authenticated;

-- ------------------------------------------------------------ выдача прав --

/*
 * Собственно назначение админа. Выполняется здесь и только здесь — из
 * приложения такой строки нет и быть не может.
 */
insert into public.admins (id, title)
select p.id, 'создатель'
from public.profiles p
where lower(p.username) = 'qiwi'
on conflict (id) do update set title = excluded.title;

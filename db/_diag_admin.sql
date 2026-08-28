-- Проверка админки. Ничего не меняет, только смотрит.
-- Выполнить в SQL Editor целиком и показать результат.

-- 1. Кто записан админом
select 'админы' as что, a.id::text as значение, p.username as ник, a.title as подпись
from public.admins a
left join public.profiles p on p.id = a.id

union all

-- 2. Существуют ли нужные функции
select 'функции', p.proname, '', ''
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_admin','admin_find','admin_delete_account','wipe_account','delete_account')

union all

-- 3. Что с целевым аккаунтом
select 'цель', id::text, username, coalesce(deleted_at::text, 'жив')
from public.profiles
where lower(username) = 'testserver2'

union all

-- 4. Есть ли у нас право трогать auth.users — самое подозрительное место.
--    Если прав нет, удаление падает целиком, потому что блокировка входа
--    делается именно там.
select 'право на auth.users',
       case when has_table_privilege(current_user, 'auth.users', 'UPDATE')
            then 'ЕСТЬ' else 'НЕТ — вот и причина' end,
       current_user, ''

union all

-- 5. От чьего имени работают функции: у SECURITY DEFINER права берутся
--    у владельца, а не у вызывающего
select 'владелец is_admin', pg_get_userbyid(p.proowner), '', ''
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'is_admin';

-- ============================================================================
--  Qiwigram — удалённый аккаунт замолкает сразу.
--  Запускать ПОСЛЕ 08_admin.sql. Идемпотентно.
-- ============================================================================

/*
 * Зачем это понадобилось.
 *
 * Удаление аккаунта ставит `banned_until` в auth.users, и это закрывает вход.
 * Но токен, выданный ДО удаления, продолжает действовать примерно час:
 * он проверяется по подписи, без обращения к базе, и о том, что аккаунта
 * больше нет, попросту не знает. Всё это время удалённый пишет как ни в чём
 * не бывало — у собеседника уже стоит «аккаунт удалён», а сообщения идут.
 *
 * Отозвать выданный токен нельзя. Зато можно перестать принимать от него
 * записи: правила доступа читают базу при каждом запросе, а там метка
 * удаления уже стоит. Это и делается ниже.
 */

create or replace function public.is_alive(_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from profiles where id = coalesce(_user, auth.uid()) and deleted_at is null
    );
$$;

grant execute on function public.is_alive(uuid) to authenticated;

/*
 * Право писать в чат. Основа — версия из 06_social.sql (та, что учитывает
 * блокировки), к ней добавлена одна проверка в начале.
 *
 * ВНИМАНИЕ: функция объявлена и в schema.sql, и в 06_social.sql. Если будешь
 * править её дальше — бери самое позднее объявление, иначе потеряешь то,
 * что добавили в промежутке. Однажды так уже потеряли пол-функции.
 */
create or replace function public.can_post_chat(_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select public.is_alive() and exists (
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

grant execute on function public.can_post_chat(uuid) to authenticated;

/* Править и удалять старые сообщения удалённому тоже незачем: аккаунта нет,
   а переписка у собеседника осталась и меняться задним числом не должна. */
drop policy if exists messages_edit on public.messages;
create policy messages_edit on public.messages
    for update to authenticated
    using (sender_id = auth.uid() and public.is_alive())
    with check (sender_id = auth.uid());

/* Профиль тоже правке не подлежит: иначе удалённый вернёт себе имя и
   аватар, и «аккаунт удалён» превратится в обычный живой профиль. */
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
    for update to authenticated
    using (id = auth.uid() and public.is_alive())
    with check (id = auth.uid());

/*
 * Ещё и сессии обрываем — то, что можно оборвать.
 *
 * Сам токен доживёт свой час в любом случае, но обновить его по истечении
 * уже не выйдет: строки, по которым выдаётся новый, удалены. Вместе с
 * правилами выше это значит, что удалённый молчит сразу и отваливается
 * окончательно, как только истечёт то, что у него на руках.
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

    /* Служебные таблицы auth в разных версиях Supabase выглядят по-разному,
       и упереться в отсутствующую — не повод отменить всё удаление.
       Поэтому каждая чистка отдельно и молча переживает неудачу. */
    begin
        delete from auth.refresh_tokens where user_id = _id::text;
    exception when others then null;
    end;

    begin
        delete from auth.sessions where user_id = _id;
    exception when others then null;
    end;
end $$;

revoke all on function public.wipe_account(uuid) from public, anon, authenticated;

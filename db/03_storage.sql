-- ============================================================================
--  Qiwigram — хранилище фотографий и видео.
--  Запускать ТРЕТЬИМ, после schema.sql и 02_overview.sql.
--
--  Отдельным файлом намеренно: таблицы схемы storage принадлежат служебной
--  роли, и в некоторых проектах политики на них из редактора не создаются.
--  Упади это внутри общего скрипта — откатилась бы вся схема разом.
--  Здесь же максимум, что потеряется, — вложения; переписка будет работать.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

/* Класть файлы может любой вошедший, но только в папку, названную его
   собственным id — так никто не перезапишет чужое вложение.

   Читать может кто угодно, у кого есть ссылка. Это осознанный размен: имена
   файлов — случайные uuid, подобрать их нельзя, а закрытое хранилище
   потребовало бы подписывать заново каждую ссылку в каждом сообщении раз в
   час, что на ленте из сотни картинок означает сотню запросов при каждом
   открытии чата. */
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
    for select using (bucket_id = 'media');

drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'media'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'media'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

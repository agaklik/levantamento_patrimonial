-- Sistema de origem de cada cliente (de onde vêm os bens e para onde volta o arquivo).
-- Rode no SQL Editor do Supabase. Pode ser executado mais de uma vez.
alter table public.clientes add column if not exists sistema text;
update public.clientes set sistema = 'Governança Brasil' where id = 1 and sistema is null;
select id, nome, sistema from public.clientes order by id;

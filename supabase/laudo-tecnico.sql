-- Levantamento Patrimonial — laudo técnico na reavaliação
-- (imóveis, veículos e máquinas avaliados por profissional habilitado)
-- Cole no SQL Editor do Supabase e clique em Run. Pode ser executado mais de uma vez.
alter table public.reavaliacao add column if not exists laudo_tecnico jsonb;

-- =====================================================================
-- Levantamento Patrimonial — conclusão das localizações e valores de
-- referência por tipo de bem
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de seguranca.sql, reavaliacao.sql e usuarios.sql.
-- =====================================================================

-- ---------- localizações com levantamento concluído ----------
-- Qualquer usuário logado marca a conclusão (app de campo ou painel).
-- Quem concluiu, o nome e a data/hora são gravados pelo banco, não pelo app.
-- Só administrador reabre (apaga a linha).
create table if not exists public.localizacoes_concluidas (
  cod            text primary key,          -- código da localização
  descricao      text,
  total          int,                       -- bens da localização no momento da conclusão
  encontrados    int,                       -- bens levantados no momento da conclusão
  concluido_por  uuid,
  concluido_nome text,
  concluido_em   timestamptz not null default now()
);

create or replace function public.carimbar_conclusao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.concluido_por  := auth.uid();
  new.concluido_em   := now();
  new.concluido_nome := coalesce(
    (select nome from public.usuarios where user_id = auth.uid()),
    auth.jwt() ->> 'email');
  return new;
end $$;

drop trigger if exists carimbar_conclusao on public.localizacoes_concluidas;
create trigger carimbar_conclusao before insert or update on public.localizacoes_concluidas
  for each row execute function public.carimbar_conclusao();

alter table public.localizacoes_concluidas enable row level security;
drop policy if exists lc_ler      on public.localizacoes_concluidas;
drop policy if exists lc_concluir on public.localizacoes_concluidas;
drop policy if exists lc_reabrir  on public.localizacoes_concluidas;
create policy lc_ler      on public.localizacoes_concluidas for select to authenticated using (true);
create policy lc_concluir on public.localizacoes_concluidas for insert to authenticated with check (true);
create policy lc_reabrir  on public.localizacoes_concluidas for delete to authenticated using (public.is_admin());
grant select, insert, delete on public.localizacoes_concluidas to authenticated;

-- ---------- valor de referência por tipo de bem ----------
-- Um valor por descrição de bem: todos os bens com a mesma descrição usam
-- o mesmo valor de referência, em qualquer localização e em qualquer data.
create table if not exists public.referencias (
  chave          text primary key,          -- descrição normalizada (sem acento, maiúscula)
  descricao      text,
  valor          numeric(16,2) not null,
  fonte          text,
  precos         jsonb,                     -- preços escolhidos na pesquisa
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
alter table public.referencias enable row level security;
drop policy if exists ref_ler   on public.referencias;
drop policy if exists ref_admin on public.referencias;
create policy ref_ler   on public.referencias for select to authenticated using (true);
create policy ref_admin on public.referencias for all    to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.referencias to authenticated;

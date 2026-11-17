-- =====================================================================
-- Levantamento Patrimonial — LicitaCon por região (associações de municípios)
--
-- Uma região é uma lista de municípios (ex.: AMGSR). No painel, "Carregar a
-- região" baixa do TCE-RS as prefeituras (e, se marcado, as câmaras) desses
-- municípios, e um clique marca ou desmarca a região inteira como referência.
-- A marcação de cada órgão agora fica salva (coluna marcado).
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de supabase/licitacon.sql.
-- =====================================================================

alter table public.licitacon_orgaos add column if not exists marcado boolean not null default true;

create table if not exists public.licitacon_regioes (
  id               bigint generated always as identity primary key,
  nome             text not null unique,
  municipios       text[] not null default '{}',   -- nomes como no TCE-RS (ex.: SANTA ROSA)
  incluir_camaras  boolean not null default false,
  criado_em        timestamptz not null default now()
);
alter table public.licitacon_regioes enable row level security;
-- sem políticas: só a função "precos" (chave de serviço) lê e grava
revoke all on public.licitacon_regioes from anon, authenticated;

-- espaço ocupado pelos itens do LicitaCon (tabela + índices), para o painel mostrar
create or replace function public.licitacon_espaco()
returns bigint language sql stable security definer set search_path = public as $$
  select pg_total_relation_size('public.licitacon_itens')
$$;
revoke all on function public.licitacon_espaco() from public, anon, authenticated;
grant execute on function public.licitacon_espaco() to service_role;

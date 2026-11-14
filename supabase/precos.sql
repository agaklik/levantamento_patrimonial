-- =====================================================================
-- Levantamento Patrimonial — pesquisa de preços de referência
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de supabase/reavaliacao.sql.
-- =====================================================================

-- preços escolhidos pelo avaliador para cada bem (vão para o laudo)
alter table public.reavaliacao add column if not exists precos jsonb;

-- cache das consultas ao Compras.gov.br (usado só pela função "precos")
create table if not exists public.precos_cache (
  chave     text primary key,
  resposta  jsonb not null,
  amostra   jsonb,
  criado_em timestamptz not null default now()
);
alter table public.precos_cache enable row level security;
-- sem políticas: só a função (chave de serviço) lê e grava
revoke all on public.precos_cache from anon, authenticated;

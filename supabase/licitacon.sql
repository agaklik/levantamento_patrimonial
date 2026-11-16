-- =====================================================================
-- Levantamento Patrimonial — preços do LicitaCon (TCE-RS)
--
-- O TCE-RS publica as licitações de cada órgão gaúcho em um arquivo ZIP
-- (dados.tce.rs.gov.br), sem busca por palavra. A função "precos" baixa o
-- arquivo dos órgãos que o administrador escolher (a prefeitura e vizinhas),
-- guarda aqui os itens com valor homologado dos últimos 3 anos e pesquisa
-- por palavra nesta tabela.
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de supabase/precos.sql.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

-- órgãos de referência escolhidos no painel
create table if not exists public.licitacon_orgaos (
  cd_orgao      int primary key,
  nome          text not null,
  municipio     text,
  itens         int not null default 0,
  arquivo_de    text,               -- data do arquivo no site do TCE-RS
  carregado_em  timestamptz not null default now()
);
alter table public.licitacon_orgaos enable row level security;
revoke all on public.licitacon_orgaos from anon, authenticated;

-- itens de licitação com valor unitário homologado
create table if not exists public.licitacon_itens (
  id             bigint generated always as identity primary key,
  cd_orgao       int not null references public.licitacon_orgaos(cd_orgao) on delete cascade,
  orgao          text,
  municipio      text,
  licitacao      text,               -- ex.: "PRE 45/2025"
  modalidade     text,
  nr_lote        text,
  nr_item        text,
  descricao      text not null,
  busca          text not null,      -- descrição sem acento, em minúsculas
  unidade        text,
  quantidade     numeric,
  valor          numeric not null,   -- valor unitário homologado
  valor_estimado numeric,
  data           date,               -- homologação (ou abertura)
  fornecedor     text,
  objeto         text,
  link           text
);
create index if not exists licitacon_itens_orgao on public.licitacon_itens (cd_orgao);
create index if not exists licitacon_itens_data on public.licitacon_itens (data);
create index if not exists licitacon_itens_busca on public.licitacon_itens using gin (busca extensions.gin_trgm_ops);
alter table public.licitacon_itens enable row level security;
-- sem políticas: só a função (chave de serviço) lê e grava
revoke all on public.licitacon_itens from anon, authenticated;

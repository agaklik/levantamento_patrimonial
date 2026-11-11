-- =====================================================================
-- Levantamento Patrimonial — tabelas da página de administração
-- (reavaliação dos bens e configuração dos documentos)
--
-- Como usar:
--   1. Execute antes o supabase/seguranca.sql (este script depende da
--      função is_admin() criada por ele).
--   2. No painel do Supabase, abra "SQL Editor", cole este arquivo e
--      clique em "Run". Pode ser executado mais de uma vez.
--
-- Acesso: qualquer usuário logado pode ler; só administrador grava.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Execute antes o script supabase/seguranca.sql';
  end if;
end $$;

-- ---------- reavaliação: um registro por bem ----------
create table if not exists public.reavaliacao (
  codigo                 text primary key,        -- código do bem (bens.codigo)
  metodo                 text not null default 'fator',  -- fator | mercado | laudo
  valor_anterior         numeric(16,2),           -- valor contábil no momento da avaliação
  valor_referencia       numeric(16,2),           -- preço de bem novo (método do fator)
  ec                     numeric(6,2),            -- nota do estado de conservação
  pvu                    numeric(6,2),            -- vida útil futura (0 a 10)
  pub                    numeric(6,2),            -- tempo de uso (0 a 10)
  fator                  numeric(8,4),
  valor_reavaliado       numeric(16,2),
  vida_util_remanescente numeric(6,1),            -- nova vida útil, em anos
  valor_residual         numeric(16,2),
  fonte                  text,                    -- fonte da pesquisa de preços
  observacao             text,
  data_avaliacao         date,
  concluido              boolean not null default false,
  atualizado_em          timestamptz not null default now(),
  atualizado_por         uuid
);

-- ---------- configuração: linha única com os dados do órgão ----------
create table if not exists public.configuracao (
  id            int primary key default 1 check (id = 1),
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

alter table public.reavaliacao  enable row level security;
alter table public.configuracao enable row level security;

drop policy if exists reav_ler   on public.reavaliacao;
drop policy if exists reav_admin on public.reavaliacao;
create policy reav_ler   on public.reavaliacao for select to authenticated using (true);
create policy reav_admin on public.reavaliacao for all    to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists cfg_ler   on public.configuracao;
drop policy if exists cfg_admin on public.configuracao;
create policy cfg_ler   on public.configuracao for select to authenticated using (true);
create policy cfg_admin on public.configuracao for all    to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.reavaliacao, public.configuracao to authenticated;

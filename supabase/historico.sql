-- =====================================================================
-- Levantamento Patrimonial — autor de cada registro e histórico de alterações
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- inteiro e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de seguranca-acesso.sql.
--
-- O que faz:
--   1. Grava, no próprio banco, quem levantou cada bem e quem fez cada
--      reavaliação. O navegador não escolhe esse nome: vem da sessão.
--   2. Guarda um histórico de tudo o que foi incluído, alterado ou excluído
--      no levantamento, na reavaliação, nos valores por tipo de bem, na
--      conclusão das localizações e na placa dos bens: quem, quando e o
--      valor de antes e de depois. Só administradores leem; ninguém altera.
-- =====================================================================

-- nome de quem está logado (cadastro de usuários; se faltar, o e-mail)
create or replace function public.nome_do_usuario()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(trim(nome), '') from public.usuarios where user_id = auth.uid()),
    auth.jwt() ->> 'email');
$$;
revoke all on function public.nome_do_usuario() from public, anon, authenticated;

-- ---------- 1. autor ----------
alter table public.levantamento add column if not exists usuario uuid;
alter table public.levantamento add column if not exists usuario_nome text;
alter table public.reavaliacao  add column if not exists atualizado_por uuid;
alter table public.reavaliacao  add column if not exists atualizado_por_nome text;

create or replace function public.carimbar_levantamento()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_nome text; mudou boolean;
begin
  if auth.uid() is null then return new; end if;   -- servidor (chave de serviço)
  if tg_op = 'UPDATE' then
    -- só mudou a comissão (ajuste em lote do painel): o autor do levantamento continua o mesmo
    mudou := (to_jsonb(new) - array['cod_comissao','atualizado_em','usuario','usuario_nome'])
             is distinct from (to_jsonb(old) - array['cod_comissao','atualizado_em','usuario','usuario_nome']);
    if not mudou then new.usuario := old.usuario; new.usuario_nome := old.usuario_nome; return new; end if;
  end if;
  -- administrador recebendo o arquivo do app de campo: vale quem levantou, informado no arquivo
  if public.is_admin() and new.usuario_nome is not null
     and (tg_op = 'INSERT' or new.usuario_nome is distinct from old.usuario_nome) then
    if position('@' in new.usuario_nome) > 0 then
      select u.id, coalesce(nullif(trim(p.nome), ''), u.email) into v_id, v_nome
        from auth.users u left join public.usuarios p on p.user_id = u.id
       where lower(u.email) = lower(new.usuario_nome) limit 1;
      if v_id is not null then new.usuario := v_id; new.usuario_nome := v_nome; else new.usuario := null; end if;
    else
      new.usuario := null;
    end if;
    return new;
  end if;
  new.usuario := auth.uid();
  new.usuario_nome := public.nome_do_usuario();
  return new;
end $$;
revoke all on function public.carimbar_levantamento() from public, anon, authenticated;
drop trigger if exists carimbar_levantamento on public.levantamento;
create trigger carimbar_levantamento before insert or update on public.levantamento
  for each row execute function public.carimbar_levantamento();

create or replace function public.carimbar_reavaliacao()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  new.atualizado_por := auth.uid();
  new.atualizado_por_nome := public.nome_do_usuario();
  return new;
end $$;
revoke all on function public.carimbar_reavaliacao() from public, anon, authenticated;
drop trigger if exists carimbar_reavaliacao on public.reavaliacao;
create trigger carimbar_reavaliacao before insert or update on public.reavaliacao
  for each row execute function public.carimbar_reavaliacao();

-- ---------- 2. histórico ----------
create table if not exists public.historico (
  id           bigint generated always as identity primary key,
  quando       timestamptz not null default now(),
  tabela       text not null,
  codigo       text,
  acao         text not null check (acao in ('incluiu','alterou','excluiu')),
  campos       text[],
  antes        jsonb,
  depois       jsonb,
  usuario      uuid,
  usuario_nome text
);
create index if not exists historico_item   on public.historico (tabela, codigo, quando desc);
create index if not exists historico_quando on public.historico (quando desc);
alter table public.historico enable row level security;
revoke all on public.historico from anon, authenticated;
grant select on public.historico to authenticated;
drop policy if exists hist_ler on public.historico;
create policy hist_ler on public.historico for select to authenticated using (public.is_admin());
-- sem regra de inclusão, alteração ou exclusão: só os gatilhos abaixo gravam

create or replace function public.registrar_historico()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ign text[] := array['id','atualizado_em','atualizado_por','atualizado_por_nome','usuario','usuario_nome'];
  j_old jsonb; j_new jsonb; chg text[]; lin jsonb;
begin
  if tg_op <> 'INSERT' then j_old := to_jsonb(old) - ign; end if;
  if tg_op <> 'DELETE' then j_new := to_jsonb(new) - ign; end if;
  lin := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into chg
      from jsonb_each(j_new) n where n.value is distinct from (j_old -> n.key);
    if chg is null then return null; end if;   -- nada mudou de verdade
    j_old := (select jsonb_object_agg(k, j_old -> k) from unnest(chg) k);
    j_new := (select jsonb_object_agg(k, j_new -> k) from unnest(chg) k);
  end if;
  insert into public.historico (tabela, codigo, acao, campos, antes, depois, usuario, usuario_nome)
  values (tg_table_name, coalesce(lin ->> 'codigo', lin ->> 'cod', lin ->> 'chave', lin ->> 'id'),
          case tg_op when 'INSERT' then 'incluiu' when 'UPDATE' then 'alterou' else 'excluiu' end,
          chg, jsonb_strip_nulls(j_old), jsonb_strip_nulls(j_new),
          auth.uid(), case when auth.uid() is null then 'servidor' else public.nome_do_usuario() end);
  return null;
end $$;
revoke all on function public.registrar_historico() from public, anon, authenticated;

drop trigger if exists historico on public.levantamento;
create trigger historico after insert or update or delete on public.levantamento
  for each row execute function public.registrar_historico();
drop trigger if exists historico on public.reavaliacao;
create trigger historico after insert or update or delete on public.reavaliacao
  for each row execute function public.registrar_historico();
drop trigger if exists historico on public.referencias;
create trigger historico after insert or update or delete on public.referencias
  for each row execute function public.registrar_historico();
drop trigger if exists historico on public.localizacoes_concluidas;
create trigger historico after insert or delete on public.localizacoes_concluidas
  for each row execute function public.registrar_historico();
-- bens: só alterações (a importação do cadastro inclui milhares de linhas de uma vez)
drop trigger if exists historico on public.bens;
create trigger historico after update or delete on public.bens
  for each row execute function public.registrar_historico();

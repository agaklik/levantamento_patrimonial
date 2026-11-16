-- =====================================================================
-- Levantamento Patrimonial — bens encontrados sem cadastro (sobras)
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- inteiro e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de seguranca-acesso.sql e historico.sql.
--
-- O que faz: cria a lista de bens que estão fisicamente no local mas não
-- constam no cadastro. A equipe de campo registra pelo app (descrição,
-- placa se houver, localização, estado e fotos); o administrador acompanha
-- e dá a destinação pelo painel.
-- =====================================================================

create table if not exists public.sobras (
  id              uuid primary key default gen_random_uuid(),
  descricao       text not null check (length(trim(descricao)) >= 3),
  placa           text,
  marca           text,
  modelo          text,
  cod_localizacao text,
  localizacao     text,
  cod_estado      text,
  estado          text,
  observacao      text,
  fotos           int not null default 0,
  situacao        text not null default 'pendente' check (situacao in ('pendente','resolvido')),
  destinacao      text,          -- o que foi decidido: incorporar, devolver, bem de terceiro...
  resolvido_em    timestamptz,
  usuario         uuid,
  usuario_nome    text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists sobras_local on public.sobras (cod_localizacao);
alter table public.sobras enable row level security;
revoke all on public.sobras from anon, authenticated;
grant select, insert, update, delete on public.sobras to authenticated;

drop policy if exists sob_ler on public.sobras;
create policy sob_ler on public.sobras for select to authenticated using (public.usuario_ativo());
drop policy if exists sob_incluir on public.sobras;
create policy sob_incluir on public.sobras for insert to authenticated with check (public.usuario_ativo());
-- quem registrou pode corrigir enquanto estiver pendente; o administrador pode tudo
drop policy if exists sob_alterar on public.sobras;
create policy sob_alterar on public.sobras for update to authenticated
  using (public.is_admin() or (public.usuario_ativo() and usuario = auth.uid() and situacao = 'pendente'))
  with check (public.is_admin() or (public.usuario_ativo() and usuario = auth.uid() and situacao = 'pendente'));
drop policy if exists sob_excluir on public.sobras;
create policy sob_excluir on public.sobras for delete to authenticated using (public.is_admin());

-- autor e datas vêm do banco, não do navegador
create or replace function public.carimbar_sobra()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.usuario := auth.uid(); new.usuario_nome := public.nome_do_usuario(); new.criado_em := now();
    if not public.is_admin() then new.situacao := 'pendente'; new.destinacao := null; new.resolvido_em := null; end if;
  else
    new.usuario := old.usuario; new.usuario_nome := old.usuario_nome; new.criado_em := old.criado_em;
    if new.situacao = 'resolvido' and old.situacao <> 'resolvido' then new.resolvido_em := now(); end if;
    if new.situacao = 'pendente' then new.resolvido_em := null; end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;
revoke all on function public.carimbar_sobra() from public, anon, authenticated;
drop trigger if exists carimbar_sobra on public.sobras;
create trigger carimbar_sobra before insert or update on public.sobras
  for each row execute function public.carimbar_sobra();

-- entra no histórico de alterações (a função é regravada aqui para identificar a sobra pelo id)
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
drop trigger if exists historico on public.sobras;
create trigger historico after insert or update or delete on public.sobras
  for each row execute function public.registrar_historico();

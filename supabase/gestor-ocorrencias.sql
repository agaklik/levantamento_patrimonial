-- =====================================================================
-- Levantamento Patrimonial — painel do gestor (só leitura) e
-- ocorrências registradas pela equipe de campo
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- inteiro e clique em "Run". Pode ser executado mais de uma vez.
-- Rodar depois de todos os outros scripts (clientes.sql, sobras.sql etc.).
--
-- O que faz:
--   1. cria o perfil "gestor" (prefeito, secretário, controlador): entra no
--      painel e vê os números, o andamento, as ocorrências e o relatório
--      executivo do próprio órgão, mas NÃO grava nada em lugar nenhum.
--      O bloqueio é do banco (políticas restritivas), não só das telas;
--   2. cria a tabela de ocorrências do campo (sala trancada, bem danificado,
--      risco, divergência de cadastro...), com autor, data, fotos e a
--      resposta do administrador. Ficam guardadas para o relatório executivo;
--   3. inclui as ocorrências na base de demonstração (restaurar/guardar).
-- =====================================================================

-- ---------- 1. perfil gestor ----------
alter table public.usuarios drop constraint if exists usuarios_perfil_check;
alter table public.usuarios add constraint usuarios_perfil_check check (perfil in ('admin','campo','gestor'));
alter table public.usuarios drop constraint if exists usuarios_gestor_nao_geral;
alter table public.usuarios add constraint usuarios_gestor_nao_geral check (not (perfil = 'gestor' and geral));

create or replace function public.eh_gestor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios where user_id = auth.uid() and perfil = 'gestor');
$$;
revoke all on function public.eh_gestor() from public, anon;
grant execute on function public.eh_gestor() to authenticated;

-- gestor nunca é administrador: sai da tabela admins e não pode voltar a ela
create or replace function public.gestor_sem_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'usuarios' then
    if new.perfil = 'gestor' then delete from public.admins where user_id = new.user_id; end if;
  elsif exists (select 1 from public.usuarios where user_id = new.user_id and perfil = 'gestor') then
    raise exception 'Gestor (só leitura) não pode ser administrador. Mude o perfil antes.';
  end if;
  return new;
end $$;
revoke all on function public.gestor_sem_admin() from public, anon, authenticated;
drop trigger if exists usuarios_gestor_sem_admin on public.usuarios;
create trigger usuarios_gestor_sem_admin after insert or update of perfil on public.usuarios
  for each row execute function public.gestor_sem_admin();
drop trigger if exists admins_sem_gestor on public.admins;
create trigger admins_sem_gestor before insert or update on public.admins
  for each row execute function public.gestor_sem_admin();
delete from public.admins a using public.usuarios u where u.user_id = a.user_id and u.perfil = 'gestor';

-- meu_cliente passa a informar o perfil (o app de campo manda o gestor para o painel)
create or replace function public.meu_cliente()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'nome', c.nome, 'pasta', coalesce(c.pasta, ''),
                            'ativo', c.ativo, 'geral', public.eh_geral(), 'demonstracao', c.demonstracao,
                            'acesso_ate', (select u.acesso_ate from public.usuarios u where u.user_id = auth.uid()),
                            'perfil', (select u.perfil from public.usuarios u where u.user_id = auth.uid()))
    from public.clientes c where c.id = public.cliente_atual();
$$;

-- ---------- 2. ocorrências do campo ----------
create table if not exists public.ocorrencias (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      integer not null default public.cliente_atual() references public.clientes(id),
  tipo            text not null check (tipo in ('acesso','dano','risco','cadastro','outro')),
  texto           text not null check (length(trim(texto)) >= 5),
  cod_localizacao text,
  localizacao     text,
  codigo          text,          -- bem relacionado, se houver
  placa           text,
  descricao_bem   text,
  fotos           int not null default 0,
  situacao        text not null default 'aberta' check (situacao in ('aberta','resolvida')),
  resposta        text,          -- providência informada pelo administrador
  resolvido_por   uuid,
  resolvido_nome  text,
  resolvido_em    timestamptz,
  usuario         uuid,
  usuario_nome    text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists ocorrencias_cliente on public.ocorrencias (cliente_id, criado_em desc);
alter table public.ocorrencias enable row level security;
revoke all on public.ocorrencias from anon, authenticated;
grant select, insert, update, delete on public.ocorrencias to authenticated;

drop policy if exists oc_ler on public.ocorrencias;
create policy oc_ler on public.ocorrencias for select to authenticated
  using (cliente_id = (select public.cliente_atual()));
drop policy if exists oc_incluir on public.ocorrencias;
create policy oc_incluir on public.ocorrencias for insert to authenticated
  with check (cliente_id = (select public.cliente_atual()) and (select public.usuario_ativo()));
-- quem registrou corrige enquanto estiver aberta; o administrador responde e resolve
drop policy if exists oc_alterar on public.ocorrencias;
create policy oc_alterar on public.ocorrencias for update to authenticated
  using (cliente_id = (select public.cliente_atual()) and ((select public.is_admin()) or (usuario = auth.uid() and situacao = 'aberta')))
  with check (cliente_id = (select public.cliente_atual()) and ((select public.is_admin()) or (usuario = auth.uid() and situacao = 'aberta')));
drop policy if exists oc_excluir on public.ocorrencias;
create policy oc_excluir on public.ocorrencias for delete to authenticated
  using (cliente_id = (select public.cliente_atual()) and (select public.is_admin()));

-- autor, datas e resposta vêm do banco, não do navegador
create or replace function public.carimbar_ocorrencia()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.usuario := auth.uid(); new.usuario_nome := public.nome_do_usuario(); new.criado_em := now();
    new.situacao := 'aberta'; new.resposta := null;
    new.resolvido_por := null; new.resolvido_nome := null; new.resolvido_em := null;
  else
    new.usuario := old.usuario; new.usuario_nome := old.usuario_nome; new.criado_em := old.criado_em;
    if not public.is_admin() then
      new.situacao := old.situacao; new.resposta := old.resposta;
    end if;
    if new.situacao = 'resolvida' and old.situacao <> 'resolvida' then
      new.resolvido_por := auth.uid(); new.resolvido_nome := public.nome_do_usuario(); new.resolvido_em := now();
    elsif new.situacao = 'aberta' then
      new.resolvido_por := null; new.resolvido_nome := null; new.resolvido_em := null;
    else
      new.resolvido_por := old.resolvido_por; new.resolvido_nome := old.resolvido_nome; new.resolvido_em := old.resolvido_em;
    end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;
revoke all on function public.carimbar_ocorrencia() from public, anon, authenticated;
drop trigger if exists carimbar_ocorrencia on public.ocorrencias;
create trigger carimbar_ocorrencia before insert or update on public.ocorrencias
  for each row execute function public.carimbar_ocorrencia();

-- ---------- 3. gestor só lê: políticas restritivas em tudo o que grava ----------
do $$
declare t text;
begin
  foreach t in array array['bens','levantamento','localizacoes','motivos','comissoes','configuracao',
                           'reavaliacao','referencias','localizacoes_concluidas','sobras','ocorrencias','avisos'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', t || '_gestor_incluir', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (not (select public.eh_gestor()))', t || '_gestor_incluir', t);
    execute format('drop policy if exists %I on public.%I', t || '_gestor_alterar', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (not (select public.eh_gestor())) with check (not (select public.eh_gestor()))', t || '_gestor_alterar', t);
    execute format('drop policy if exists %I on public.%I', t || '_gestor_excluir', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (not (select public.eh_gestor()))', t || '_gestor_excluir', t);
  end loop;
end $$;

-- fotos e laudos: o gestor vê, mas não envia, troca nem apaga
drop policy if exists fotos_gestor_enviar on storage.objects;
create policy fotos_gestor_enviar on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'fotos' or not (select public.eh_gestor()));
drop policy if exists fotos_gestor_alterar on storage.objects;
create policy fotos_gestor_alterar on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'fotos' or not (select public.eh_gestor()));
drop policy if exists fotos_gestor_excluir on storage.objects;
create policy fotos_gestor_excluir on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'fotos' or not (select public.eh_gestor()));

-- ---------- 4. base de demonstração: ocorrências entram em guardar/restaurar ----------
do $$
begin
  if to_regnamespace('demo') is null then return; end if;
  execute $f$
    create or replace function demo.tabelas()
    returns text[] language sql immutable as $g$
      select array['configuracao','motivos','comissoes','localizacoes','bens','levantamento','referencias',
                   'reavaliacao','localizacoes_concluidas','sobras','ocorrencias','avisos','historico'];
    $g$;
  $f$;
  revoke all on function demo.tabelas() from public, anon, authenticated;
  -- o ponto de partida já guardado não tinha ocorrências: entra vazio
  insert into demo.foto (cliente_id, tabela, linhas, guardado_em, guardado_por)
  select distinct f.cliente_id, 'ocorrencias', '[]'::jsonb, max(f.guardado_em) over (partition by f.cliente_id), 'instalação das ocorrências'
    from demo.foto f
  on conflict (cliente_id, tabela) do nothing;
end $$;

-- ---------- conferência ----------
select 'ocorrências' as item, (to_regclass('public.ocorrencias') is not null)::text as ok
union all select 'função eh_gestor', (to_regprocedure('public.eh_gestor()') is not null)::text
union all select 'políticas de só leitura', count(*)::text from pg_policies where policyname like '%gestor%';

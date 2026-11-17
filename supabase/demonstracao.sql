-- =====================================================================
-- Base de demonstração: ponto de partida guardado e botão "Restaurar"
-- =====================================================================
-- Rodar no SQL Editor do Supabase (pode rodar mais de uma vez).
--
--   • clientes.demonstracao: marca o cliente usado em demonstrações.
--   • demo.foto: guarda uma "foto" de todos os dados do cliente de
--     demonstração (bens, localizações, levantamento, reavaliação,
--     valores por tipo, conclusões, sobras, avisos, configuração e
--     histórico). O esquema "demo" não fica exposto na API.
--   • demo_guardar(): a equipe da empresa guarda o estado atual como
--     ponto de partida.
--   • demo_restaurar(): a equipe da empresa volta o cliente de
--     demonstração ao ponto de partida, apagando o que foi feito depois
--     (por exemplo, por quem testou). Usuários e senhas não mudam.
--   • meu_cliente() passa a dizer se o cliente é de demonstração.
--
-- Só funciona em cliente marcado como demonstração: os dados de
-- clientes reais nunca são apagados por estas funções.
-- =====================================================================

alter table public.clientes add column if not exists demonstracao boolean not null default false;

create schema if not exists demo;
revoke all on schema demo from public, anon, authenticated;

create table if not exists demo.foto (
  cliente_id  integer not null references public.clientes(id) on delete cascade,
  tabela      text    not null,
  linhas      jsonb   not null default '[]'::jsonb,
  guardado_em timestamptz not null default now(),
  guardado_por text,
  primary key (cliente_id, tabela)
);
revoke all on demo.foto from public, anon, authenticated;

-- tabelas do cliente, na ordem em que podem ser incluídas (pais antes dos filhos)
create or replace function demo.tabelas()
returns text[] language sql immutable as $$
  select array['configuracao','motivos','comissoes','localizacoes','bens','levantamento','referencias',
               'reavaliacao','localizacoes_concluidas','sobras','avisos','historico'];
$$;

-- grava a foto do cliente (uso interno; sem conferência de permissão)
create or replace function demo.guardar(p_cliente integer, p_quem text)
returns jsonb language plpgsql security definer set search_path = public, demo as $$
declare t text; n integer; res jsonb := '{}'::jsonb; j jsonb;
begin
  if not exists (select 1 from public.clientes where id = p_cliente and demonstracao) then
    raise exception 'O cliente % não está marcado como demonstração.', p_cliente;
  end if;
  foreach t in array demo.tabelas() loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb), count(*) from public.%I x where x.cliente_id = $1', t)
      into j, n using p_cliente;
    insert into demo.foto (cliente_id, tabela, linhas, guardado_em, guardado_por)
    values (p_cliente, t, j, now(), p_quem)
    on conflict (cliente_id, tabela) do update set linhas = excluded.linhas, guardado_em = excluded.guardado_em, guardado_por = excluded.guardado_por;
    res := res || jsonb_build_object(t, n);
  end loop;
  return res;
end $$;

-- volta o cliente à foto (uso interno; sem conferência de permissão)
create or replace function demo.restaurar(p_cliente integer)
returns jsonb language plpgsql security definer set search_path = public, demo as $$
declare t text; i integer; tabs text[] := demo.tabelas(); res jsonb := '{}'::jsonb; n integer; seq text;
begin
  if not exists (select 1 from public.clientes where id = p_cliente and demonstracao) then
    raise exception 'O cliente % não está marcado como demonstração.', p_cliente;
  end if;
  if (select count(*) from demo.foto where cliente_id = p_cliente) < array_length(tabs, 1) then
    raise exception 'Ainda não há ponto de partida guardado para este cliente.';
  end if;
  -- sem gatilhos durante a troca: não gera histórico, avisos nem carimbos de usuário
  foreach t in array tabs loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
  alter table public.avisos_lidos disable trigger user;
  delete from public.avisos_lidos where aviso_id in (select id from public.avisos where cliente_id = p_cliente);
  -- apaga dos filhos para os pais
  for i in reverse array_length(tabs, 1) .. 1 loop
    execute format('delete from public.%I where cliente_id = $1', tabs[i]) using p_cliente;
  end loop;
  -- inclui dos pais para os filhos
  foreach t in array tabs loop
    execute format('insert into public.%1$I overriding system value
                      select r.* from demo.foto f, jsonb_populate_recordset(null::public.%1$I, f.linhas) r
                       where f.cliente_id = $1 and f.tabela = %2$L', t, t) using p_cliente;
    get diagnostics n = row_count;
    res := res || jsonb_build_object(t, n);
    -- contador de ids (identity) acima do maior id
    for seq in select pg_get_serial_sequence('public.' || t, a.attname)
                 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attidentity <> '' loop
      if seq is not null then
        execute format('select setval(%L, coalesce((select max(id) from public.%I), 1))', seq, t);
      end if;
    end loop;
  end loop;
  foreach t in array tabs loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;
  alter table public.avisos_lidos enable trigger user;
  return res;
end $$;
revoke all on function demo.guardar(integer, text), demo.restaurar(integer), demo.tabelas() from public, anon, authenticated;

-- ---------- chamadas do painel (só a equipe da empresa) ----------
create or replace function public.demo_info()
returns jsonb language sql stable security definer set search_path = public, demo as $$
  select jsonb_build_object(
    'demonstracao', coalesce((select c.demonstracao from public.clientes c where c.id = public.cliente_atual()), false),
    'guardado_em', (select max(f.guardado_em) from demo.foto f where f.cliente_id = public.cliente_atual()),
    'guardado_por', (select max(f.guardado_por) from demo.foto f where f.cliente_id = public.cliente_atual()),
    'bens', (select jsonb_array_length(f.linhas) from demo.foto f where f.cliente_id = public.cliente_atual() and f.tabela = 'bens'),
    'levantamento', (select jsonb_array_length(f.linhas) from demo.foto f where f.cliente_id = public.cliente_atual() and f.tabela = 'levantamento'))
  where public.eh_geral();
$$;

create or replace function public.demo_guardar()
returns jsonb language plpgsql security definer set search_path = public, demo as $$
begin
  if not public.eh_geral() then raise exception 'Só a equipe da empresa pode guardar o ponto de partida.' using errcode = '42501'; end if;
  return demo.guardar(public.cliente_atual(), public.nome_do_usuario());
end $$;

create or replace function public.demo_restaurar()
returns jsonb language plpgsql security definer set search_path = public, demo as $$
begin
  if not public.eh_geral() then raise exception 'Só a equipe da empresa pode restaurar a demonstração.' using errcode = '42501'; end if;
  return demo.restaurar(public.cliente_atual());
end $$;

revoke all on function public.demo_info(), public.demo_guardar(), public.demo_restaurar() from public, anon;
grant execute on function public.demo_info(), public.demo_guardar(), public.demo_restaurar() to authenticated;

-- meu_cliente: inclui "demonstracao"
create or replace function public.meu_cliente()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'nome', c.nome, 'pasta', coalesce(c.pasta, ''),
                            'ativo', c.ativo, 'geral', public.eh_geral(), 'demonstracao', c.demonstracao,
                            'acesso_ate', (select u.acesso_ate from public.usuarios u where u.user_id = auth.uid()))
    from public.clientes c where c.id = public.cliente_atual();
$$;

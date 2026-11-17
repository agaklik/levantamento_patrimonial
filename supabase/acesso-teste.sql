-- =====================================================================
-- Acesso de teste com prazo (licença por dias)
--
-- Como usar: cole este arquivo inteiro no SQL Editor do Supabase e clique
-- em "Run". Rode DEPOIS do clientes.sql. Pode ser executado mais de uma vez.
--
-- O que ele faz:
--   • Cria a coluna usuarios.acesso_ate. Vazia = acesso sem prazo (como hoje).
--     Preenchida = usuário de teste: a partir desse momento ele não enxerga
--     mais nenhum dado, nem pelo app, nem pelo painel, nem direto pela API.
--   • O prazo vale no banco: as funções que liberam os dados (usuario_ativo,
--     is_admin, cliente_atual, eh_geral) passam a conferir a data. Não depende
--     da tela nem do celular.
--   • Só a equipe da empresa define ou muda o prazo (pela aba Usuários do
--     painel, que usa a função "usuarios" no servidor). Usuário de teste não
--     pode ser da empresa, não troca de cliente e não cadastra usuários.
--   • meu_prazo(): devolve o prazo de quem está logado, mesmo vencido, para a
--     tela avisar "seu período de teste terminou em ...".
-- =====================================================================

alter table public.usuarios add column if not exists acesso_ate timestamptz;

-- usuário de teste nunca é "da empresa"
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'usuarios_teste_nao_geral') then
    alter table public.usuarios add constraint usuarios_teste_nao_geral
      check (not (geral and acesso_ate is not null));
  end if;
end $$;

-- prazo em dia: null = sem prazo
create or replace function public.prazo_ok(p_ate timestamptz)
returns boolean language sql stable as $$
  select p_ate is null or p_ate > now();
$$;

create or replace function public.usuario_ativo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios
                  where user_id = auth.uid() and ativo and public.prazo_ok(acesso_ate));
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
     and exists (select 1 from public.usuarios
                  where user_id = auth.uid() and ativo and public.prazo_ok(acesso_ate));
$$;

create or replace function public.cliente_atual()
returns integer language sql stable security definer set search_path = public as $$
  select u.cliente_id from public.usuarios u join public.clientes c on c.id = u.cliente_id
   where u.user_id = auth.uid() and u.ativo and public.prazo_ok(u.acesso_ate)
     and (c.ativo or u.geral);
$$;

create or replace function public.eh_geral()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios u
                  where u.user_id = auth.uid() and u.ativo and u.geral and u.acesso_ate is null)
     and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- dados do cliente atual + prazo (o app mostra "teste até ...")
create or replace function public.meu_cliente()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'nome', c.nome, 'pasta', coalesce(c.pasta, ''),
                            'ativo', c.ativo, 'geral', public.eh_geral(),
                            'acesso_ate', (select u.acesso_ate from public.usuarios u where u.user_id = auth.uid()))
    from public.clientes c where c.id = public.cliente_atual();
$$;

-- prazo de quem está logado, mesmo vencido (só o próprio)
create or replace function public.meu_prazo()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('acesso_ate', u.acesso_ate, 'vencido', not public.prazo_ok(u.acesso_ate))
    from public.usuarios u where u.user_id = auth.uid();
$$;

revoke all on function public.meu_prazo() from public, anon;
grant execute on function public.prazo_ok(timestamptz), public.usuario_ativo(), public.is_admin(),
  public.cliente_atual(), public.eh_geral(), public.meu_cliente(), public.meu_prazo() to authenticated;

-- conferência: usuários de teste e quanto falta
select u.nome, u.usuario, c.nome as cliente, u.acesso_ate,
       case when u.acesso_ate is null then 'sem prazo'
            when u.acesso_ate > now() then 'em teste'
            else 'vencido' end as situacao
  from public.usuarios u join public.clientes c on c.id = u.cliente_id
 order by u.acesso_ate nulls first, u.nome;

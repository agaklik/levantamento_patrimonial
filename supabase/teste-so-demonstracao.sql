-- =====================================================================
-- Acesso de teste só no cliente de demonstração
-- =====================================================================
-- Rodar no SQL Editor do Supabase depois de demonstracao.sql e acesso-teste.sql
-- (pode rodar mais de uma vez).
--
--   • Usuário com prazo de teste (acesso_ate) só pode ficar ligado a um cliente
--     marcado como demonstração. O banco recusa o cadastro ou a troca de cliente
--     em qualquer outro caso.
--   • Mesmo que algo escape dessa regra, cliente_atual() não devolve cliente
--     real para usuário de teste: ele não enxerga nenhum dado.
--   • Um cliente com usuários de teste não pode deixar de ser demonstração.
-- =====================================================================

create or replace function public.cliente_atual()
returns integer language sql stable security definer set search_path = public as $$
  select u.cliente_id from public.usuarios u join public.clientes c on c.id = u.cliente_id
   where u.user_id = auth.uid() and u.ativo and public.prazo_ok(u.acesso_ate)
     and (c.ativo or u.geral)
     and (u.acesso_ate is null or c.demonstracao);
$$;

create or replace function public.usuarios_teste_so_demo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.acesso_ate is not null
     and not exists (select 1 from public.clientes c where c.id = new.cliente_id and c.demonstracao) then
    raise exception 'Acesso de teste só pode ser dado no cliente de demonstração.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists usuarios_teste_so_demo on public.usuarios;
create trigger usuarios_teste_so_demo before insert or update of acesso_ate, cliente_id on public.usuarios
  for each row execute function public.usuarios_teste_so_demo();

create or replace function public.clientes_demo_com_testes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.demonstracao and not new.demonstracao
     and exists (select 1 from public.usuarios u where u.cliente_id = new.id and u.acesso_ate is not null) then
    raise exception 'Este cliente tem usuários de teste. Tire o prazo deles antes de desmarcar a demonstração.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists clientes_demo_com_testes on public.clientes;
create trigger clientes_demo_com_testes before update of demonstracao on public.clientes
  for each row execute function public.clientes_demo_com_testes();

revoke all on function public.usuarios_teste_so_demo(), public.clientes_demo_com_testes() from public, anon, authenticated;

-- conferência: usuários de teste fora da demonstração (deve vir vazio)
select u.nome, c.nome as cliente from public.usuarios u join public.clientes c on c.id = u.cliente_id
 where u.acesso_ate is not null and not c.demonstracao;

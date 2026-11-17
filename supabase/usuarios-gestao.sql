-- Gestão de usuários: excluir quem foi cadastrado errado e bloqueio por senha errada
-- Rode uma vez no SQL Editor do Supabase, depois do usuarios.sql, seguranca-acesso.sql e clientes.sql.
--
-- O que muda:
--  1. coluna "protegido" em public.usuarios: conta que ninguém exclui, bloqueia nem
--     tira de administrador, nem pelo painel do Supabase (Authentication > Delete user).
--  2. a conta do dono (o administrador mais antigo) fica protegida.
--  3. a exclusão de um usuário apaga só o acesso dele (cadastro, perfil de administrador,
--     avisos lidos, preferências e celulares inscritos para notificação, que já estão
--     ligados a auth.users com "on delete cascade"). O que ele levantou, reavaliou ou
--     registrou continua no sistema, com o nome dele gravado (colunas usuario_nome).
--  4. 3 senhas erradas seguidas: a equipe de campo fica bloqueada até um administrador
--     clicar em "Liberar acesso"; administradores voltam sozinhos depois de 15 minutos
--     (assim ninguém trava um administrador só digitando o e-mail dele errado).

alter table public.usuarios add column if not exists protegido boolean not null default false;

-- conta do dono: o administrador cadastrado primeiro
update public.usuarios set protegido = true
 where user_id = (select u.id from auth.users u join public.admins a on a.user_id = u.id
                   order by u.created_at limit 1);

-- trava no banco: conta protegida não pode ser apagada de jeito nenhum
create or replace function public.impedir_excluir_protegido()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.usuarios where user_id = old.id and protegido) then
    raise exception 'Esta conta é protegida e não pode ser excluída.';
  end if;
  return old;
end $$;
revoke all on function public.impedir_excluir_protegido() from public, anon, authenticated;
drop trigger if exists impedir_excluir_protegido on auth.users;
create trigger impedir_excluir_protegido before delete on auth.users
  for each row execute function public.impedir_excluir_protegido();

-- ---------- 4. bloqueio depois de 3 senhas erradas ----------
create or replace function public.registrar_falha_acesso(p_chave text)
returns table (n int, ate timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_campo boolean;
begin
  -- limpa registros velhos, mas mantém os bloqueios que ainda valem
  delete from public.acessos_falhos f
   where f.ultima < now() - interval '1 day' and (f.bloqueado_ate is null or f.bloqueado_ate < now());
  -- equipe de campo: cadastro existente que não é administrador nem conta protegida
  select exists (
    select 1 from auth.users u
     where lower(u.email) = lower(p_chave)
       and not exists (select 1 from public.admins a where a.user_id = u.id)
       and not exists (select 1 from public.usuarios p where p.user_id = u.id and p.protegido)
  ) into v_campo;
  return query
  insert into public.acessos_falhos as a (chave, tentativas, ultima, bloqueado_ate)
  values (p_chave, 1, now(), null)
  on conflict (chave) do update set
    tentativas = case when a.ultima < now() - interval '15 minutes' then 1 else a.tentativas + 1 end,
    ultima = now(),
    bloqueado_ate = case
      when (case when a.ultima < now() - interval '15 minutes' then 1 else a.tentativas + 1 end) >= 3
      then now() + (case when v_campo then interval '100 years' else interval '15 minutes' end)
      else null end
  returning a.tentativas, a.bloqueado_ate;
end $$;
revoke all on function public.registrar_falha_acesso(text) from public, anon, authenticated;
grant execute on function public.registrar_falha_acesso(text) to service_role;

-- confira: deve aparecer o seu e-mail
select u.email as conta_protegida, p.nome
  from public.usuarios p join auth.users u on u.id = p.user_id
 where p.protegido;

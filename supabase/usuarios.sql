-- =====================================================================
-- Cadastro e controle de usuários (aba "Usuários" da página de administração)
-- Execute no SQL Editor do Supabase DEPOIS do seguranca.sql.
-- Pode ser executado mais de uma vez sem problema.
-- =====================================================================

-- perfil e situação de cada usuário. Quem grava aqui é só a função "usuarios"
-- (que roda no servidor com a chave de serviço); o navegador apenas lê.
create table if not exists public.usuarios (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  nome          text,
  perfil        text not null default 'campo' check (perfil in ('admin','campo')),
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.usuarios enable row level security;

drop policy if exists usu_ler on public.usuarios;
create policy usu_ler on public.usuarios for select to authenticated
  using (public.is_admin() or user_id = auth.uid());
grant select on public.usuarios to authenticated;

-- usuários que já existem passam a constar na tabela, com o perfil atual
insert into public.usuarios (user_id, perfil)
select u.id, case when exists (select 1 from public.admins a where a.user_id = u.id) then 'admin' else 'campo' end
  from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- Nome de usuário (opcional), para entrar sem digitar o e-mail.
-- Só letras minúsculas sem acento, números, ponto e sublinhado; único.
-- ---------------------------------------------------------------------
alter table public.usuarios add column if not exists usuario text;
alter table public.usuarios drop constraint if exists usuarios_usuario_formato;
alter table public.usuarios add constraint usuarios_usuario_formato
  check (usuario is null or usuario ~ '^[a-z0-9][a-z0-9._]{2,29}$');
create unique index if not exists usuarios_usuario_unico on public.usuarios (usuario);

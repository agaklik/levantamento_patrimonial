-- =====================================================================
-- Levantamento Patrimonial — regras de acesso (RLS) e perfil de administrador
--
-- Como usar:
--   1. Publique antes a versão v2026.11.11-26 (ou mais nova) do app.
--   2. No painel do Supabase, abra "SQL Editor", cole este arquivo inteiro.
--   3. Troque SEU_EMAIL_AQUI (no final) pelo e-mail de login do administrador.
--   4. Clique em "Run". Pode ser executado mais de uma vez sem problema.
--
-- O que ele faz:
--   • Cria a tabela "admins" e a função is_admin(), usada pelo app para
--     mostrar a engrenagem só a administradores.
--   • Liga o RLS nas 5 tabelas e REMOVE as políticas antigas delas,
--     criando as novas abaixo. Sem login, ninguém lê nem grava nada.
--   • Equipe de campo (usuário logado): lê tudo, grava o levantamento
--     e atualiza o bem (placa encontrada em campo).
--   • Só administrador: importa/exclui bens, localizações e motivos,
--     cadastra a comissão e exclui levantamentos.
--   • Torna o bucket "fotos" privado (fotos só para usuários logados).
-- =====================================================================

-- ---------- administradores ----------
create table if not exists public.admins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- remove políticas antigas e liga o RLS ----------
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('bens','levantamento','localizacoes','motivos','comissoes','admins')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

alter table public.bens          enable row level security;
alter table public.levantamento  enable row level security;
alter table public.localizacoes  enable row level security;
alter table public.motivos       enable row level security;
alter table public.comissoes     enable row level security;

-- admins: cada um só enxerga a própria linha; ninguém altera pelo app
create policy admins_ler_proprio on public.admins
  for select to authenticated using (user_id = auth.uid());

-- bens
create policy bens_ler       on public.bens for select to authenticated using (true);
create policy bens_atualizar on public.bens for update to authenticated using (true) with check (true);
create policy bens_incluir   on public.bens for insert to authenticated with check (public.is_admin());
create policy bens_excluir   on public.bens for delete to authenticated using (public.is_admin());

-- levantamento
create policy lev_ler       on public.levantamento for select to authenticated using (true);
create policy lev_incluir   on public.levantamento for insert to authenticated with check (true);
create policy lev_atualizar on public.levantamento for update to authenticated using (true) with check (true);
create policy lev_excluir   on public.levantamento for delete to authenticated using (public.is_admin());

-- tabelas de apoio: todos leem, só administrador altera
create policy loc_ler   on public.localizacoes for select to authenticated using (true);
create policy loc_admin on public.localizacoes for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy mot_ler   on public.motivos for select to authenticated using (true);
create policy mot_admin on public.motivos for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy com_ler   on public.comissoes for select to authenticated using (true);
create policy com_admin on public.comissoes for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- fotos: bucket privado ----------
update storage.buckets set public = false where id = 'fotos';

-- remove políticas antigas do Storage que tratam do bucket "fotos"
do $$
declare p record;
begin
  for p in
    select policyname
      from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual,'') ilike '%fotos%' or coalesce(with_check,'') ilike '%fotos%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy fotos_ler     on storage.objects for select to authenticated using (bucket_id = 'fotos');
create policy fotos_enviar  on storage.objects for insert to authenticated with check (bucket_id = 'fotos');
create policy fotos_excluir on storage.objects for delete to authenticated using (bucket_id = 'fotos' and public.is_admin());

-- ---------- quem é administrador ----------
-- Troque pelo e-mail de login. Para mais de um, repita a linha do insert.
insert into public.admins (user_id)
select id from auth.users where email = 'SEU_EMAIL_AQUI'
on conflict do nothing;

-- Conferência: deve listar ao menos um administrador.
select u.email as administrador from public.admins a join auth.users u on u.id = a.user_id;

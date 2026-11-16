-- =====================================================================
-- Levantamento Patrimonial — reforço de segurança (acesso e permissões)
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este arquivo
-- inteiro e clique em "Run". Pode ser executado mais de uma vez.
-- Depende de seguranca.sql, usuarios.sql, reavaliacao.sql e conclusao.sql.
--
-- O que faz:
--   1. Só usuário CADASTRADO e ATIVO (tabela "usuarios") lê ou grava dados
--      e fotos. Uma conta criada por fora do painel não enxerga nada, e um
--      usuário bloqueado perde o acesso na hora.
--   2. Contagem de senhas erradas, usada pela função "usuarios" para
--      bloquear o acesso por 15 minutos depois de 3 erros.
--   3. Equipe de campo só altera a placa do bem; o restante do cadastro
--      de bens fica para o administrador.
--   4. Visitante sem login perde todas as permissões nas tabelas.
--   5. Limite de tamanho e de tipo de arquivo no depósito de fotos.
-- =====================================================================

-- ---------- 1. usuário cadastrado e ativo ----------
-- garante que todo administrador atual tenha cadastro (para ninguém ficar de fora)
insert into public.usuarios (user_id, perfil)
select a.user_id, 'admin' from public.admins a
on conflict (user_id) do nothing;

create or replace function public.usuario_ativo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios where user_id = auth.uid() and ativo);
$$;
revoke all on function public.usuario_ativo() from public, anon;
grant execute on function public.usuario_ativo() to authenticated;

-- administrador = está na lista de administradores E está ativo
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
     and exists (select 1 from public.usuarios where user_id = auth.uid() and ativo);
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- regras de leitura e de gravação do dia a dia passam a exigir usuário ativo
drop policy if exists bens_ler on public.bens;
create policy bens_ler on public.bens for select to authenticated using (public.usuario_ativo());
drop policy if exists bens_atualizar on public.bens;
create policy bens_atualizar on public.bens for update to authenticated using (public.usuario_ativo()) with check (public.usuario_ativo());

drop policy if exists lev_ler on public.levantamento;
create policy lev_ler on public.levantamento for select to authenticated using (public.usuario_ativo());
drop policy if exists lev_incluir on public.levantamento;
create policy lev_incluir on public.levantamento for insert to authenticated with check (public.usuario_ativo());
drop policy if exists lev_atualizar on public.levantamento;
create policy lev_atualizar on public.levantamento for update to authenticated using (public.usuario_ativo()) with check (public.usuario_ativo());

drop policy if exists loc_ler on public.localizacoes;
create policy loc_ler on public.localizacoes for select to authenticated using (public.usuario_ativo());
drop policy if exists mot_ler on public.motivos;
create policy mot_ler on public.motivos for select to authenticated using (public.usuario_ativo());
drop policy if exists com_ler on public.comissoes;
create policy com_ler on public.comissoes for select to authenticated using (public.usuario_ativo());
drop policy if exists cfg_ler on public.configuracao;
create policy cfg_ler on public.configuracao for select to authenticated using (public.usuario_ativo());
drop policy if exists reav_ler on public.reavaliacao;
create policy reav_ler on public.reavaliacao for select to authenticated using (public.usuario_ativo());
drop policy if exists ref_ler on public.referencias;
create policy ref_ler on public.referencias for select to authenticated using (public.usuario_ativo());
drop policy if exists lc_ler on public.localizacoes_concluidas;
create policy lc_ler on public.localizacoes_concluidas for select to authenticated using (public.usuario_ativo());
drop policy if exists lc_concluir on public.localizacoes_concluidas;
create policy lc_concluir on public.localizacoes_concluidas for insert to authenticated with check (public.usuario_ativo());

-- fotos e laudos
drop policy if exists fotos_ler on storage.objects;
create policy fotos_ler on storage.objects for select to authenticated using (bucket_id = 'fotos' and public.usuario_ativo());
drop policy if exists fotos_enviar on storage.objects;
create policy fotos_enviar on storage.objects for insert to authenticated with check (bucket_id = 'fotos' and public.usuario_ativo());

-- ---------- 2. senhas erradas ----------
create table if not exists public.acessos_falhos (
  chave         text primary key,          -- e-mail (ou o que foi digitado, se não existir cadastro)
  tentativas    int not null default 0,
  ultima        timestamptz not null default now(),
  bloqueado_ate timestamptz
);
alter table public.acessos_falhos enable row level security;
-- sem políticas: só a função "usuarios" (chave de serviço) lê e grava
revoke all on public.acessos_falhos from anon, authenticated;

-- registra uma senha errada; na 3ª seguida bloqueia por 15 minutos
create or replace function public.registrar_falha_acesso(p_chave text)
returns table (n int, ate timestamptz)
language sql security definer set search_path = public as $$
  delete from public.acessos_falhos where ultima < now() - interval '1 day';
  insert into public.acessos_falhos as a (chave, tentativas, ultima, bloqueado_ate)
  values (p_chave, 1, now(), null)
  on conflict (chave) do update set
    tentativas = case when a.ultima < now() - interval '15 minutes' then 1 else a.tentativas + 1 end,
    ultima = now(),
    bloqueado_ate = case
      when (case when a.ultima < now() - interval '15 minutes' then 1 else a.tentativas + 1 end) >= 3
      then now() + interval '15 minutes' else null end
  returning a.tentativas, a.bloqueado_ate;
$$;
revoke all on function public.registrar_falha_acesso(text) from public, anon, authenticated;
grant execute on function public.registrar_falha_acesso(text) to service_role;

-- ---------- 3. equipe de campo só altera a placa do bem ----------
create or replace function public.proteger_bens()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() nulo = servidor (chave de serviço); administrador pode tudo
  if auth.uid() is not null and not public.is_admin()
     and (to_jsonb(new) - 'placa') is distinct from (to_jsonb(old) - 'placa') then
    raise exception 'Apenas administradores podem alterar o cadastro de bens.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.proteger_bens() from public, anon, authenticated;
drop trigger if exists proteger_bens on public.bens;
create trigger proteger_bens before update on public.bens
  for each row execute function public.proteger_bens();

-- ---------- 4. visitante sem login não tem permissão nenhuma ----------
revoke all on all tables in schema public from anon;
revoke all on function public.carimbar_conclusao() from public, anon, authenticated;

-- ---------- 5. depósito de fotos: até 15 MB, só imagem ou PDF ----------
update storage.buckets
   set file_size_limit = 15728640,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']
 where id = 'fotos';

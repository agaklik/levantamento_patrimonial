// Função "usuarios": cadastro e controle de usuários pela página de administração,
// entrada pelo nome de usuário e recuperação de senha.
// Roda no servidor do Supabase com a chave de serviço, que nunca vai para o navegador.
//
// IMPORTANTE: no painel do Supabase, em Edge Functions > usuarios > Details,
// deixe DESLIGADO "Enforce JWT Verification" (Verify JWT). As ações "entrar" e
// "recuperar" são usadas antes do login; as demais conferem a sessão aqui dentro
// e só atendem administradores (função is_admin() do seguranca.sql).
//
// Ações (corpo JSON):
//   { acao: 'entrar', usuario, senha }                 (sem login)
//   { acao: 'recuperar', login, redirect }             (sem login; login = e-mail ou nome de usuário)
//   { acao: 'listar' }                                 (administrador)
//   { acao: 'criar', nome, usuario?, email, senha, perfil: 'campo'|'admin' }
//   { acao: 'atualizar', id, nome?, usuario?, perfil?, ativo? }
//   { acao: 'senha', id, senha }
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const BLOQUEIO = '876000h'; // ~100 anos: bloqueado até ser reativado

// ---------- regras de cadastro (as mesmas do navegador) ----------
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const USUARIO = /^[a-z0-9][a-z0-9._]{2,29}$/;
const PARTE_NOME = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]*$/;
const limparNome = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ');
function erroNome(nome: string) {
  const partes = nome.split(' ').filter(Boolean);
  if (partes.length < 2) return 'Informe o nome completo, com nome e sobrenome.';
  if (!partes.every((p) => PARTE_NOME.test(p))) return 'O nome deve ter só letras.';
  if (partes.filter((p) => p.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '').length >= 2).length < 2) return 'Informe o nome completo, com nome e sobrenome.';
  return '';
}
function erroSenha(senha: string, email = '', usuario = '') {
  const f: string[] = [];
  if (senha.length < 10) f.push('10 ou mais caracteres');
  if (!/[a-z]/.test(senha)) f.push('uma letra minúscula');
  if (!/[A-Z]/.test(senha)) f.push('uma letra maiúscula');
  if (!/\d/.test(senha)) f.push('um número');
  if (!/[^A-Za-z0-9]/.test(senha)) f.push('um símbolo');
  const s = senha.toLowerCase();
  const local = email.split('@')[0].toLowerCase();
  if ((local.length >= 4 && s.includes(local)) || (usuario.length >= 4 && s.includes(usuario.toLowerCase())))
    f.push('não conter o e-mail nem o nome de usuário');
  return f.length ? 'A senha precisa ter: ' + f.join(', ') + '.' : '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adm = createClient(url, service, { auth: { persistSession: false } });
    const publico = () => createClient(url, anon, { auth: { persistSession: false } });
    const b = await req.json().catch(() => ({}));

    const emailDoUsuario = async (usuario: string) => {
      const u = usuario.trim().toLowerCase();
      if (!USUARIO.test(u)) return null;
      const { data } = await adm.from('usuarios').select('user_id,ativo').eq('usuario', u).maybeSingle();
      if (!data || data.ativo === false) return null;
      const { data: r } = await adm.auth.admin.getUserById(data.user_id);
      return r?.user?.email ?? null;
    };

    // ---------- antes do login ----------
    if (b.acao === 'entrar') {
      const falha = json({ erro: 'Usuário ou senha incorretos.' }, 400);
      const email = await emailDoUsuario(String(b.usuario ?? ''));
      if (!email) return falha;
      const { data, error } = await publico().auth.signInWithPassword({ email, password: String(b.senha ?? '') });
      if (error || !data.session) return falha;
      return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
    }
    if (b.acao === 'recuperar') {
      const login = String(b.login ?? '').trim().toLowerCase();
      const email = login.includes('@') ? login : await emailDoUsuario(login);
      // a resposta é sempre a mesma, para não revelar quem tem cadastro
      if (email && EMAIL.test(email)) {
        await publico().auth.resetPasswordForEmail(email, b.redirect ? { redirectTo: String(b.redirect) } : undefined);
      }
      return json({ ok: true });
    }

    // ---------- daqui em diante, só administradores ----------
    const asUser = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ erro: 'Sessão inválida. Entre de novo.' }, 401);
    const { data: ehAdmin } = await asUser.rpc('is_admin');
    if (ehAdmin !== true) return json({ erro: 'Apenas administradores podem gerenciar usuários.' }, 403);

    const definirPerfil = async (id: string, perfil: string) => {
      if (perfil === 'admin') {
        const { error } = await adm.from('admins').upsert({ user_id: id }, { onConflict: 'user_id' });
        if (error) throw error;
      } else {
        const { error } = await adm.from('admins').delete().eq('user_id', id);
        if (error) throw error;
      }
    };
    const usuarioLivre = async (usuario: string, id = '') => {
      const { data } = await adm.from('usuarios').select('user_id').eq('usuario', usuario);
      return !(data ?? []).some((r) => r.user_id !== id);
    };

    if (b.acao === 'listar') {
      const { data, error } = await adm.auth.admin.listUsers({ perPage: 1000 });
      if (error) throw error;
      const { data: admins } = await adm.from('admins').select('user_id');
      const { data: perfis } = await adm.from('usuarios').select('*');
      const ehAdm = new Set((admins ?? []).map((a) => a.user_id));
      const porId = new Map((perfis ?? []).map((p) => [p.user_id, p]));
      const usuarios = data.users.map((u) => {
        const p = porId.get(u.id) ?? {};
        const banido = u.banned_until ? new Date(u.banned_until) > new Date() : false;
        return {
          id: u.id, email: u.email,
          nome: p.nome ?? u.user_metadata?.nome ?? '',
          usuario: p.usuario ?? '',
          perfil: ehAdm.has(u.id) ? 'admin' : 'campo',
          ativo: !banido && p.ativo !== false,
          ultimo_acesso: u.last_sign_in_at, criado_em: u.created_at,
        };
      }).sort((a, b) => (a.nome || a.email).localeCompare(b.nome || b.email, 'pt-BR'));
      return json({ usuarios });
    }

    if (b.acao === 'criar') {
      const nome = limparNome(b.nome);
      const email = String(b.email ?? '').trim().toLowerCase();
      const usuario = String(b.usuario ?? '').trim().toLowerCase();
      const senha = String(b.senha ?? '');
      const perfil = b.perfil === 'admin' ? 'admin' : 'campo';
      const eN = erroNome(nome); if (eN) return json({ erro: eN }, 400);
      if (!EMAIL.test(email)) return json({ erro: 'Informe um e-mail válido.' }, 400);
      if (usuario && !USUARIO.test(usuario)) return json({ erro: 'Nome de usuário: de 3 a 30 caracteres, só letras minúsculas sem acento, números, ponto e sublinhado.' }, 400);
      if (usuario && !(await usuarioLivre(usuario))) return json({ erro: 'Este nome de usuário já está em uso.' }, 400);
      const eS = erroSenha(senha, email, usuario); if (eS) return json({ erro: eS }, 400);
      const { data, error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome, usuario: usuario || null } });
      if (error) return json({ erro: /already|registered|exists/i.test(error.message) ? 'Já existe um usuário com este e-mail.' : error.message }, 400);
      const id = data.user.id;
      const { error: e2 } = await adm.from('usuarios').upsert({ user_id: id, nome, usuario: usuario || null, perfil, ativo: true });
      if (e2) throw e2;
      await definirPerfil(id, perfil);
      return json({ ok: true, id });
    }

    if (b.acao === 'atualizar') {
      const id = String(b.id ?? '');
      if (!id) return json({ erro: 'Usuário não informado.' }, 400);
      if (id === user.id && (b.ativo === false || b.perfil === 'campo')) return json({ erro: 'Você não pode bloquear nem tirar o próprio acesso de administrador.' }, 400);
      const mud: Record<string, unknown> = { user_id: id, atualizado_em: new Date().toISOString() };
      if (b.nome !== undefined) {
        const nome = limparNome(b.nome); const eN = erroNome(nome); if (eN) return json({ erro: eN }, 400);
        mud.nome = nome;
      }
      if (b.usuario !== undefined) {
        const usuario = String(b.usuario ?? '').trim().toLowerCase();
        if (usuario && !USUARIO.test(usuario)) return json({ erro: 'Nome de usuário: de 3 a 30 caracteres, só letras minúsculas sem acento, números, ponto e sublinhado.' }, 400);
        if (usuario && !(await usuarioLivre(usuario, id))) return json({ erro: 'Este nome de usuário já está em uso.' }, 400);
        mud.usuario = usuario || null;
      }
      if (b.perfil !== undefined) mud.perfil = b.perfil === 'admin' ? 'admin' : 'campo';
      if (b.ativo !== undefined) mud.ativo = !!b.ativo;
      const { error } = await adm.from('usuarios').upsert(mud);
      if (error) throw error;
      if (b.perfil !== undefined) await definirPerfil(id, mud.perfil as string);
      if (b.ativo !== undefined || b.nome !== undefined || b.usuario !== undefined) {
        const attrs: Record<string, unknown> = {};
        if (b.ativo !== undefined) attrs.ban_duration = b.ativo ? 'none' : BLOQUEIO;
        if (b.nome !== undefined || b.usuario !== undefined) {
          const { data: atual } = await adm.auth.admin.getUserById(id);
          const meta = { ...(atual?.user?.user_metadata ?? {}) };
          if (mud.nome !== undefined) meta.nome = mud.nome;
          if (mud.usuario !== undefined) meta.usuario = mud.usuario;
          attrs.user_metadata = meta;
        }
        const { error: e2 } = await adm.auth.admin.updateUserById(id, attrs);
        if (e2) throw e2;
      }
      return json({ ok: true });
    }

    if (b.acao === 'senha') {
      const id = String(b.id ?? '');
      const { data: alvo } = await adm.auth.admin.getUserById(id);
      if (!alvo?.user) return json({ erro: 'Usuário não encontrado.' }, 400);
      const eS = erroSenha(String(b.senha ?? ''), alvo.user.email ?? '', String(alvo.user.user_metadata?.usuario ?? ''));
      if (eS) return json({ erro: eS }, 400);
      const { error } = await adm.auth.admin.updateUserById(id, { password: String(b.senha) });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message ?? String(e) }, 500);
  }
});

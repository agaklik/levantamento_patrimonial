// Função "usuarios": cadastro e controle de usuários pela página de administração.
// Roda no servidor do Supabase com a chave de serviço, que nunca vai para o navegador.
// Só atende quem é administrador (função is_admin() do seguranca.sql).
//
// Ações (corpo JSON):
//   { acao: 'listar' }
//   { acao: 'criar', nome, email, senha, perfil: 'campo'|'admin' }
//   { acao: 'atualizar', id, nome?, perfil?, ativo? }
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // quem está chamando? (usa o token da sessão enviado pelo navegador)
    const asUser = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ erro: 'Sessão inválida. Entre de novo.' }, 401);
    const { data: ehAdmin } = await asUser.rpc('is_admin');
    if (ehAdmin !== true) return json({ erro: 'Apenas administradores podem gerenciar usuários.' }, 403);

    const adm = createClient(url, service, { auth: { persistSession: false } });
    const b = await req.json();

    const definirPerfil = async (id: string, perfil: string) => {
      if (perfil === 'admin') {
        const { error } = await adm.from('admins').upsert({ user_id: id }, { onConflict: 'user_id' });
        if (error) throw error;
      } else {
        const { error } = await adm.from('admins').delete().eq('user_id', id);
        if (error) throw error;
      }
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
          perfil: ehAdm.has(u.id) ? 'admin' : 'campo',
          ativo: !banido && p.ativo !== false,
          ultimo_acesso: u.last_sign_in_at, criado_em: u.created_at,
        };
      }).sort((a, b) => (a.nome || a.email).localeCompare(b.nome || b.email, 'pt-BR'));
      return json({ usuarios });
    }

    if (b.acao === 'criar') {
      const email = String(b.email ?? '').trim().toLowerCase();
      const senha = String(b.senha ?? '');
      const perfil = b.perfil === 'admin' ? 'admin' : 'campo';
      if (!email || senha.length < 8) return json({ erro: 'Informe e-mail e senha com pelo menos 8 caracteres.' }, 400);
      const { data, error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome: b.nome ?? '' } });
      if (error) return json({ erro: /already|registered|exists/i.test(error.message) ? 'Já existe um usuário com este e-mail.' : error.message }, 400);
      const id = data.user.id;
      const { error: e2 } = await adm.from('usuarios').upsert({ user_id: id, nome: b.nome ?? '', perfil, ativo: true });
      if (e2) throw e2;
      await definirPerfil(id, perfil);
      return json({ ok: true, id });
    }

    if (b.acao === 'atualizar') {
      const id = String(b.id ?? '');
      if (!id) return json({ erro: 'Usuário não informado.' }, 400);
      if (id === user.id && (b.ativo === false || b.perfil === 'campo')) return json({ erro: 'Você não pode bloquear nem tirar o próprio acesso de administrador.' }, 400);
      const mud: Record<string, unknown> = { user_id: id, atualizado_em: new Date().toISOString() };
      if (b.nome !== undefined) mud.nome = b.nome;
      if (b.perfil !== undefined) mud.perfil = b.perfil === 'admin' ? 'admin' : 'campo';
      if (b.ativo !== undefined) mud.ativo = !!b.ativo;
      const { error } = await adm.from('usuarios').upsert(mud);
      if (error) throw error;
      if (b.perfil !== undefined) await definirPerfil(id, mud.perfil as string);
      if (b.ativo !== undefined || b.nome !== undefined) {
        const attrs: Record<string, unknown> = {};
        if (b.ativo !== undefined) attrs.ban_duration = b.ativo ? 'none' : BLOQUEIO;
        if (b.nome !== undefined) attrs.user_metadata = { nome: b.nome };
        const { error: e2 } = await adm.auth.admin.updateUserById(id, attrs);
        if (e2) throw e2;
      }
      return json({ ok: true });
    }

    if (b.acao === 'senha') {
      if (String(b.senha ?? '').length < 8) return json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' }, 400);
      const { error } = await adm.auth.admin.updateUserById(String(b.id), { password: String(b.senha) });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message ?? String(e) }, 500);
  }
});

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
//   { acao: 'entrar', login, senha }                   (sem login; login = e-mail ou nome de usuário;
//                                                       3 senhas erradas seguidas bloqueiam por 15 minutos)
//   { acao: 'recuperar', login, redirect }             (sem login; login = e-mail ou nome de usuário)
//   { acao: 'listar' }                                 (administrador)
//   { acao: 'criar', nome, usuario?, email, senha, perfil: 'campo'|'admin' }
//   { acao: 'atualizar', id, nome?, usuario?, perfil?, ativo? }
//   { acao: 'senha', id, senha }
//   { acao: 'desbloquear', id }                        (libera quem errou a senha 3 vezes)
//
// Acesso de teste (supabase/acesso-teste.sql): em 'criar' e 'atualizar', o campo
// acesso_ate ('AAAA-MM-DD' = vale até 23:59 desse dia, horário de Brasília; null =
// sem prazo) só é aceito da equipe da empresa. Usuário de teste não gerencia
// usuários, e o login dele é recusado depois do prazo (o banco também bloqueia).
//
// Vários clientes (supabase/clientes.sql): o administrador só vê e altera os usuários
// do cliente em que está; quem ele cadastra entra nesse mesmo cliente. Usuário "da
// empresa" (geral) só é visto e alterado por outro usuário da empresa.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const BLOQUEIO = '876000h'; // ~100 anos: bloqueado até ser reativado
const PRAZO_MAX_DIAS = 365;
const dataBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
// 'AAAA-MM-DD' -> fim desse dia no horário de Brasília (UTC-3); undefined = inválido
function prazoDe(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  const t = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const dia = new Date(t + 'T00:00:00Z');
  if (isNaN(dia.getTime()) || dia.toISOString().slice(0, 10) !== t) return undefined; // ex.: 31/02
  const hojeBR = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);   // data de hoje em Brasília
  const dias = Math.round((dia.getTime() - new Date(hojeBR + 'T00:00:00Z').getTime()) / 86400000);
  if (dias < 0 || dias > PRAZO_MAX_DIAS) return undefined;
  return new Date(t + 'T23:59:59-03:00').toISOString();
}

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
      // "v" avisa as telas de que esta versão já conta as senhas erradas
      const V = 3, MAX = 3;
      const digitado = String(b.login ?? b.usuario ?? '').trim().toLowerCase().slice(0, 200);
      const senha = String(b.senha ?? '');
      if (!digitado || !senha) return json({ v: V, erro: 'Informe o e-mail ou nome de usuário e a senha.' }, 400);
      const email = digitado.includes('@') ? (EMAIL.test(digitado) ? digitado : null) : await emailDoUsuario(digitado);
      // a contagem vale também para quem não tem cadastro, para não revelar quem tem
      const chave = email ?? digitado;
      const bloqueado = (ate: string) => json({ v: V, bloqueado_ate: ate, erro: 'Acesso bloqueado por 15 minutos depois de 3 senhas erradas.' }, 429);
      const { data: reg } = await adm.from('acessos_falhos').select('bloqueado_ate').eq('chave', chave).maybeSingle();
      if (reg?.bloqueado_ate && new Date(reg.bloqueado_ate) > new Date()) return bloqueado(reg.bloqueado_ate);
      if (email) {
        const { data, error } = await publico().auth.signInWithPassword({ email, password: senha });
        if (!error && data.session) {
          await adm.from('acessos_falhos').delete().eq('chave', chave);
          // acesso de teste vencido: não entrega a sessão (o banco também já bloqueia os dados)
          const { data: pz } = await adm.from('usuarios').select('acesso_ate').eq('user_id', data.user.id).maybeSingle();
          if (pz?.acesso_ate && new Date(pz.acesso_ate) <= new Date()) {
            return json({ v: V, prazo_vencido: pz.acesso_ate, erro: `O período de teste terminou em ${dataBR(pz.acesso_ate)}. Para continuar, fale com quem liberou o seu acesso.` }, 403);
          }
          return json({ v: V, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
        }
        if (error && /banned/i.test(error.message)) return json({ v: V, erro: 'Este usuário está bloqueado. Fale com o administrador.' }, 403);
        // erro que não é de senha (serviço fora do ar, limite de pedidos): não conta como tentativa
        if (error && (error.status ?? 400) >= 429) return json({ v: V, erro: 'Não foi possível entrar agora. Tente de novo em instantes.' }, 503);
      }
      const { data: f, error: ef } = await adm.rpc('registrar_falha_acesso', { p_chave: chave });
      const linha = Array.isArray(f) ? f[0] : f;
      if (ef || !linha) return json({ v: V, erro: 'E-mail, usuário ou senha incorretos.' }, 400); // contagem ainda não instalada
      if (linha.ate) return bloqueado(linha.ate);
      return json({ v: V, restantes: Math.max(0, MAX - linha.n), erro: 'E-mail, usuário ou senha incorretos.' }, 400);
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

    // cliente em que o administrador está trabalhando (null = banco ainda sem clientes.sql)
    const { data: eu, error: eEu } = await adm.from('usuarios').select('cliente_id,geral').eq('user_id', user.id).maybeSingle();
    // usuário de teste (com prazo) não cadastra nem altera usuários
    const { data: euPz, error: ePz } = await adm.from('usuarios').select('acesso_ate').eq('user_id', user.id).maybeSingle();
    const temPrazo = !ePz; // coluna acesso_ate instalada
    if (temPrazo && euPz?.acesso_ate) return json({ erro: 'Usuário de teste não pode gerenciar usuários.' }, 403);
    const multi = !eEu && eu != null && eu.cliente_id != null;
    const meuCliente: number | null = multi ? eu!.cliente_id : null;
    const souGeral = multi ? eu!.geral === true : true;
    // o alvo precisa ser do mesmo cliente; usuário da empresa só por outro da empresa
    const podeMexer = async (id: string) => {
      if (!multi) return true;
      const { data } = await adm.from('usuarios').select('cliente_id,geral').eq('user_id', id).maybeSingle();
      if (!data) return souGeral;
      if (data.geral) return souGeral;
      return data.cliente_id === meuCliente;
    };
    const negado = () => json({ erro: 'Este usuário não pertence ao cliente em que você está.' }, 403);

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
      let qp = adm.from('usuarios').select('*');
      if (multi) qp = qp.or(souGeral ? `cliente_id.eq.${meuCliente},geral.is.true` : `cliente_id.eq.${meuCliente}`);
      const { data: perfis } = await qp;
      const { data: falhas } = await adm.from('acessos_falhos').select('chave,bloqueado_ate').gt('bloqueado_ate', new Date().toISOString());
      const travado = new Map((falhas ?? []).map((x) => [x.chave, x.bloqueado_ate]));
      const ehAdm = new Set((admins ?? []).map((a) => a.user_id));
      const porId = new Map((perfis ?? []).map((p) => [p.user_id, p]));
      const usuarios = data.users.filter((u) => !multi || porId.has(u.id)).filter((u) => {
        const p = porId.get(u.id);
        return !multi || !p?.geral || souGeral;
      }).map((u) => {
        const p = porId.get(u.id) ?? {};
        const banido = u.banned_until ? new Date(u.banned_until) > new Date() : false;
        return {
          id: u.id, email: u.email,
          nome: p.nome ?? u.user_metadata?.nome ?? '',
          usuario: p.usuario ?? '',
          perfil: ehAdm.has(u.id) ? 'admin' : 'campo',
          geral: p.geral === true,
          ativo: !banido && p.ativo !== false,
          senha_bloqueada_ate: travado.get((u.email ?? '').toLowerCase()) ?? null,
          acesso_ate: p.acesso_ate ?? null,
          ultimo_acesso: u.last_sign_in_at, criado_em: u.created_at,
        };
      }).sort((a, b) => (a.nome || a.email).localeCompare(b.nome || b.email, 'pt-BR'));
      return json({ usuarios, geral: souGeral, prazo: temPrazo });
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
      let prazo: string | null = null;
      if (b.acesso_ate !== undefined && b.acesso_ate !== null && b.acesso_ate !== '') {
        if (!souGeral) return json({ erro: 'Só a equipe da empresa libera acesso de teste.' }, 403);
        if (!temPrazo) return json({ erro: 'Rode antes o script supabase/acesso-teste.sql no Supabase.' }, 400);
        const p = prazoDe(b.acesso_ate);
        if (p === undefined) return json({ erro: `Prazo inválido: escolha uma data de hoje até ${PRAZO_MAX_DIAS} dias.` }, 400);
        prazo = p;
      }
      const { data, error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome, usuario: usuario || null } });
      if (error) return json({ erro: /already|registered|exists/i.test(error.message) ? 'Já existe um usuário com este e-mail.' : error.message }, 400);
      const id = data.user.id;
      const linha: Record<string, unknown> = { user_id: id, nome, usuario: usuario || null, perfil, ativo: true };
      if (multi) { linha.cliente_id = meuCliente; linha.geral = souGeral && b.geral === true && perfil === 'admin' && !prazo; }
      if (prazo) linha.acesso_ate = prazo;
      const { error: e2 } = await adm.from('usuarios').upsert(linha);
      if (e2) throw e2;
      await definirPerfil(id, perfil);
      return json({ ok: true, id });
    }

    if (b.acao === 'atualizar') {
      const id = String(b.id ?? '');
      if (!id) return json({ erro: 'Usuário não informado.' }, 400);
      if (!(await podeMexer(id))) return negado();
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
      if (multi && souGeral && b.geral !== undefined) {
        if (id === user.id && b.geral === false) return json({ erro: 'Você não pode tirar o próprio acesso a todos os clientes.' }, 400);
        mud.geral = b.geral === true;
      }
      if (multi && mud.perfil === 'campo') mud.geral = false;
      if (b.acesso_ate !== undefined) {
        if (!souGeral) return json({ erro: 'Só a equipe da empresa muda o prazo de teste.' }, 403);
        if (!temPrazo) return json({ erro: 'Rode antes o script supabase/acesso-teste.sql no Supabase.' }, 400);
        if (id === user.id) return json({ erro: 'Você não pode colocar prazo no próprio acesso.' }, 400);
        const p = prazoDe(b.acesso_ate);
        if (p === undefined) return json({ erro: `Prazo inválido: escolha uma data de hoje até ${PRAZO_MAX_DIAS} dias.` }, 400);
        if (p) {
          const { data: alvo } = await adm.from('usuarios').select('geral').eq('user_id', id).maybeSingle();
          if ((mud.geral ?? alvo?.geral) === true) return json({ erro: 'Usuário da empresa não pode ter prazo de teste.' }, 400);
        }
        mud.acesso_ate = p;
      }
      if (mud.geral === true) {
        const { data: alvo } = await adm.from('usuarios').select('acesso_ate').eq('user_id', id).maybeSingle();
        if ((mud.acesso_ate !== undefined ? mud.acesso_ate : alvo?.acesso_ate)) return json({ erro: 'Usuário de teste não pode ser da empresa. Tire o prazo antes.' }, 400);
      }
      // update (e não upsert): a linha já existe e o cliente dela não muda aqui
      const { data: achou, error } = await adm.from('usuarios').update(mud).eq('user_id', id).select('user_id');
      if (!error && !(achou ?? []).length) {
        const { error: e3 } = await adm.from('usuarios').insert({ ...mud, ...(multi ? { cliente_id: meuCliente } : {}) });
        if (e3) throw e3;
      }
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
      if (!(await podeMexer(id))) return negado();
      const { data: alvo } = await adm.auth.admin.getUserById(id);
      if (!alvo?.user) return json({ erro: 'Usuário não encontrado.' }, 400);
      const eS = erroSenha(String(b.senha ?? ''), alvo.user.email ?? '', String(alvo.user.user_metadata?.usuario ?? ''));
      if (eS) return json({ erro: eS }, 400);
      const { error } = await adm.auth.admin.updateUserById(id, { password: String(b.senha) });
      if (error) throw error;
      await adm.from('acessos_falhos').delete().eq('chave', (alvo.user.email ?? '').toLowerCase());
      return json({ ok: true });
    }

    if (b.acao === 'desbloquear') {
      if (!(await podeMexer(String(b.id ?? '')))) return negado();
      const { data: alvo } = await adm.auth.admin.getUserById(String(b.id ?? ''));
      if (!alvo?.user?.email) return json({ erro: 'Usuário não encontrado.' }, 400);
      const { error } = await adm.from('acessos_falhos').delete().eq('chave', alvo.user.email.toLowerCase());
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message ?? String(e) }, 500);
  }
});

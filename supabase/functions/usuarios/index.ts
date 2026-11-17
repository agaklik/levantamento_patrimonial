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
//                                                       3 senhas erradas seguidas: equipe de campo fica bloqueada até
//                                                       o administrador liberar; administrador, 15 minutos)
//   { acao: 'recuperar', login, redirect }             (sem login; login = e-mail ou nome de usuário)
//   { acao: 'listar' }                                 (administrador)
//   { acao: 'criar', nome, usuario?, email, senha, perfil: 'campo'|'admin', enviar_email?, link? }
//   { acao: 'atualizar', id, nome?, usuario?, perfil?, ativo? }
//   { acao: 'senha', id, senha, enviar_email?, link? }
//   { acao: 'desbloquear', id }                        (libera quem errou a senha 3 vezes)
//   { acao: 'resumo', id }                             (o que a pessoa já registrou, antes de excluir)
//   { acao: 'excluir', id }                            (apaga o acesso; o que ela registrou continua)
//
// Senha definida pelo administrador (cadastro ou "Nova senha") é provisória: fica marcada
// em user_metadata.trocar_senha, e o app e o painel pedem uma senha nova no primeiro acesso.
// Com enviar_email, a pessoa recebe por e-mail o link do app, o login e a senha provisória.
// O envio usa o Gmail (SMTP) informado nos segredos da função, em Edge Functions > Secrets:
//   SMTP_USER = conta do Gmail que envia; SMTP_PASS = senha de app dessa conta (16 letras);
//   opcionais: SMTP_HOST (smtp.gmail.com), SMTP_PORT (465), SMTP_NOME (nome do remetente).
//
// Exclusão (supabase/excluir-usuario.sql): ninguém exclui a si mesmo nem uma conta
// "protegida" (a do dono), que também não pode ser bloqueada nem perder o perfil de
// administrador. Os registros feitos pela pessoa ficam, com o nome dela gravado.
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
import nodemailer from 'npm:nodemailer@6.9.16';

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

// ---------- e-mail de acesso (senha provisória) ----------
const escH = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function linkValido(v: unknown): string {
  const t = String(v ?? '').trim();
  try { const u = new URL(t); return u.protocol === 'https:' && t.length <= 300 ? u.href : ''; } catch { return ''; }
}
// devolve '' quando enviou, ou o motivo de não ter enviado
async function enviarAcesso(o: { para: string; nome: string; usuario: string; senha: string; link: string; novo: boolean }): Promise<string> {
  const user = Deno.env.get('SMTP_USER'), pass = Deno.env.get('SMTP_PASS');
  if (!user || !pass) return 'o envio de e-mail ainda não foi configurado (segredos SMTP_USER e SMTP_PASS da função)';
  const port = Number(Deno.env.get('SMTP_PORT') || 465);
  const remetente = Deno.env.get('SMTP_NOME') || 'Levantamento Patrimonial';
  const primeiro = o.nome.split(' ')[0] || o.nome;
  const assunto = o.novo ? 'Seu acesso ao Levantamento Patrimonial' : 'Nova senha provisória do Levantamento Patrimonial';
  const intro = o.novo ? 'Você foi cadastrado(a) no Levantamento Patrimonial.' : 'O administrador definiu uma nova senha provisória para você.';
  const login = o.usuario ? `${o.para} ou ${o.usuario}` : o.para;
  const texto = `Olá, ${primeiro}!\n\n${intro}\n\nEndereço: ${o.link}\nE-mail ou usuário: ${login}\nSenha provisória: ${o.senha}\n\n` +
    'No primeiro acesso, o sistema pede para você criar uma senha sua. Não compartilhe esta senha com ninguém.\n' +
    'Depois de 3 senhas erradas seguidas o acesso fica bloqueado.\n\nSe você não esperava este e-mail, ignore-o.';
  const linha = (r: string, v: string, mono = false) =>
    `<tr><td style="padding:6px 0;color:#5B6675;font-size:13px;width:150px">${r}</td><td style="padding:6px 0;font-size:15px;color:#18212B;${mono ? "font-family:Consolas,'Courier New',monospace;font-weight:700;letter-spacing:.5px" : ''}">${escH(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#EEF1F5;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#18212B;padding:18px 24px;color:#fff;font-size:17px;font-weight:700">Levantamento Patrimonial<div style="height:3px;width:44px;background:#F5C518;margin-top:8px"></div></td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;font-size:16px;color:#18212B">Olá, ${escH(primeiro)}!</p>
<p style="margin:0 0 18px;font-size:15px;color:#18212B;line-height:1.5">${escH(intro)} Use os dados abaixo para entrar.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #E3E7ED;border-bottom:1px solid #E3E7ED;margin-bottom:20px">
${linha('E-mail ou usuário', login)}${linha('Senha provisória', o.senha, true)}</table>
<p style="margin:0 0 22px;text-align:center"><a href="${escH(o.link)}" style="display:inline-block;background:#2347A8;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 26px;border-radius:8px">Abrir o aplicativo</a></p>
<p style="margin:0 0 10px;font-size:13.5px;color:#18212B;line-height:1.5">No primeiro acesso, o sistema pede para você criar uma senha sua. Não compartilhe esta senha com ninguém. Depois de 3 senhas erradas seguidas, o acesso fica bloqueado.</p>
<p style="margin:0;font-size:12.5px;color:#5B6675;line-height:1.5">Se o botão não abrir, copie este endereço no navegador: ${escH(o.link)}<br>Se você não esperava este e-mail, ignore-o.</p>
</td></tr></table></td></tr></table></body></html>`;
  try {
    const t = nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST') || 'smtp.gmail.com', port, secure: port === 465, auth: { user, pass },
    });
    await t.sendMail({ from: { name: remetente, address: user }, to: o.para, subject: assunto, text: texto, html });
    return '';
  } catch (e) {
    return 'o e-mail não pôde ser enviado (' + ((e as Error).message ?? String(e)).slice(0, 160) + ')';
  }
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
      const bloqueado = (ate: string) => json({ v: V, bloqueado_ate: ate, erro: new Date(ate).getTime() - Date.now() > 86400000
        ? 'Acesso bloqueado depois de 3 senhas erradas. Peça ao administrador para liberar.'
        : 'Acesso bloqueado por 15 minutos depois de 3 senhas erradas.' }, 429);
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
    // conta do dono (coluna criada pelo excluir-usuario.sql; sem a coluna, ninguém é protegido)
    const protegido = async (id: string) => {
      const { data, error } = await adm.from('usuarios').select('protegido').eq('user_id', id).maybeSingle();
      return !error && data?.protegido === true;
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
          protegido: p.protegido === true,
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
      const link = linkValido(b.link);
      if (b.enviar_email && !link) return json({ erro: 'Endereço do app inválido para o e-mail.' }, 400);
      const { data, error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome, usuario: usuario || null, trocar_senha: true } });
      if (error) return json({ erro: /already|registered|exists/i.test(error.message) ? 'Já existe um usuário com este e-mail.' : error.message }, 400);
      const id = data.user.id;
      const linha: Record<string, unknown> = { user_id: id, nome, usuario: usuario || null, perfil, ativo: true };
      if (multi) { linha.cliente_id = meuCliente; linha.geral = souGeral && b.geral === true && perfil === 'admin' && !prazo; }
      if (prazo) linha.acesso_ate = prazo;
      const { error: e2 } = await adm.from('usuarios').upsert(linha);
      if (e2) throw e2;
      await definirPerfil(id, perfil);
      const falhaEmail = b.enviar_email ? await enviarAcesso({ para: email, nome, usuario, senha, link, novo: true }) : null;
      return json({ ok: true, id, email_enviado: falhaEmail === '', aviso_email: falhaEmail || null });
    }

    if (b.acao === 'atualizar') {
      const id = String(b.id ?? '');
      if (!id) return json({ erro: 'Usuário não informado.' }, 400);
      if (!(await podeMexer(id))) return negado();
      if (id === user.id && (b.ativo === false || b.perfil === 'campo')) return json({ erro: 'Você não pode bloquear nem tirar o próprio acesso de administrador.' }, 400);
      if ((b.ativo === false || b.perfil === 'campo' || b.geral === false || (b.acesso_ate !== undefined && b.acesso_ate !== null && b.acesso_ate !== '')) && (await protegido(id)))
        return json({ erro: 'Esta conta é protegida: não pode ser bloqueada, ter prazo nem perder o acesso de administrador.' }, 400);
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
      const link = linkValido(b.link);
      if (b.enviar_email && !link) return json({ erro: 'Endereço do app inválido para o e-mail.' }, 400);
      // senha definida pelo administrador é provisória: a pessoa cria a dela no próximo acesso
      const meta = { ...(alvo.user.user_metadata ?? {}), trocar_senha: id !== user.id };
      const { error } = await adm.auth.admin.updateUserById(id, { password: String(b.senha), user_metadata: meta });
      if (error) throw error;
      await adm.from('acessos_falhos').delete().eq('chave', (alvo.user.email ?? '').toLowerCase());
      const falhaEmail = b.enviar_email
        ? await enviarAcesso({ para: alvo.user.email ?? '', nome: String(meta.nome ?? ''), usuario: String(meta.usuario ?? ''), senha: String(b.senha), link, novo: false })
        : null;
      return json({ ok: true, email_enviado: falhaEmail === '', aviso_email: falhaEmail || null });
    }

    if (b.acao === 'desbloquear') {
      if (!(await podeMexer(String(b.id ?? '')))) return negado();
      const { data: alvo } = await adm.auth.admin.getUserById(String(b.id ?? ''));
      if (!alvo?.user?.email) return json({ erro: 'Usuário não encontrado.' }, 400);
      const { error } = await adm.from('acessos_falhos').delete().eq('chave', alvo.user.email.toLowerCase());
      if (error) throw error;
      return json({ ok: true });
    }

    if (b.acao === 'resumo' || b.acao === 'excluir') {
      const id = String(b.id ?? '');
      if (!id) return json({ erro: 'Usuário não informado.' }, 400);
      if (!(await podeMexer(id))) return negado();
      if (id === user.id) return json({ erro: 'Você não pode excluir a própria conta.' }, 400);
      if (await protegido(id)) return json({ erro: 'Esta conta é protegida e não pode ser excluída.' }, 400);
      const { data: alvo } = await adm.auth.admin.getUserById(id);
      if (!alvo?.user) return json({ erro: 'Usuário não encontrado. Atualize a lista.' }, 400);
      const { data: perfil } = await adm.from('usuarios').select('*').eq('user_id', id).maybeSingle();

      if (b.acao === 'resumo') {
        // quantos registros a pessoa já fez (tabela ausente conta 0)
        const contar = async (tabela: string, coluna: string) => {
          const { count, error } = await adm.from(tabela).select('*', { count: 'exact', head: true }).eq(coluna, id);
          return error ? 0 : (count ?? 0);
        };
        const [levantamentos, reavaliacoes, sobras] = await Promise.all([
          contar('levantamento', 'usuario'), contar('reavaliacao', 'atualizado_por'), contar('sobras', 'usuario'),
        ]);
        return json({ levantamentos, reavaliacoes, sobras, ultimo_acesso: alvo.user.last_sign_in_at ?? null });
      }

      // não deixa o cliente sem nenhum administrador ativo
      const { data: admins } = await adm.from('admins').select('user_id');
      const ids = (admins ?? []).map((a) => a.user_id);
      if (ids.includes(id)) {
        let q = adm.from('usuarios').select('user_id').in('user_id', ids.filter((x) => x !== id)).neq('ativo', false);
        if (multi && perfil?.cliente_id != null && !perfil?.geral) q = q.or(`cliente_id.eq.${perfil.cliente_id},geral.is.true`);
        const { data: outros } = await q;
        if (!(outros ?? []).length) return json({ erro: 'Este é o último administrador ativo. Cadastre outro antes de excluir.' }, 400);
      }

      const { error } = await adm.auth.admin.deleteUser(id);
      if (error) {
        const m = error.message ?? '';
        if (/protegida/i.test(m)) return json({ erro: 'Esta conta é protegida e não pode ser excluída.' }, 400);
        return json({ erro: 'Não foi possível excluir: ' + m + '. Se preferir, use "Bloquear".' }, 400);
      }
      // sobra do cadastro, se algo não estiver ligado por "on delete cascade"
      await adm.from('admins').delete().eq('user_id', id);
      await adm.from('usuarios').delete().eq('user_id', id);
      await adm.from('acessos_falhos').delete().eq('chave', (alvo.user.email ?? '').toLowerCase());
      // registra no histórico quem excluiu (falha aqui não desfaz a exclusão)
      const { data: meuPerfil } = await adm.from('usuarios').select('nome').eq('user_id', user.id).maybeSingle();
      const linha: Record<string, unknown> = {
        tabela: 'usuarios', codigo: alvo.user.email, acao: 'excluiu',
        antes: { nome: perfil?.nome ?? alvo.user.user_metadata?.nome ?? null, email: alvo.user.email, perfil: ids.includes(id) ? 'administrador' : 'equipe de campo' },
        usuario: user.id, usuario_nome: meuPerfil?.nome || user.email,
      };
      if (multi) linha.cliente_id = perfil?.geral ? meuCliente : (perfil?.cliente_id ?? meuCliente);
      await adm.from('historico').insert(linha);
      return json({ ok: true });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message ?? String(e) }, 500);
  }
});

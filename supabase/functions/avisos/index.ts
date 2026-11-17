// Função "avisos": envia notificações (Web Push) do painel para o celular de quem
// usa o app de campo, e os avisos automáticos do sistema.
// Roda no servidor do Supabase com a chave de serviço, que nunca vai para o navegador.
//
// IMPORTANTE: no painel do Supabase, em Edge Functions > avisos > Details,
// deixe DESLIGADO "Enforce JWT Verification" (Verify JWT). A ação "chave" é pública
// (devolve só a chave pública das notificações); as demais conferem a sessão aqui
// dentro, e a "rotina" confere o segredo gravado no banco (supabase/avisos.sql).
//
// Não precisa configurar nenhum segredo: na primeira chamada a função cria o par de
// chaves das notificações (VAPID) e guarda na tabela push_config, que só o servidor lê.
//
// Ações (corpo JSON):
//   { acao: 'chave' }                                   (sem login) chave pública para o celular se inscrever
//   { acao: 'teste' }                                   (qualquer usuário) manda "Notificações ligadas" aos aparelhos dele
//   { acao: 'destinatarios' }                           (administrador) usuários do cliente, com aparelhos e preferências
//   { acao: 'enviar', titulo, texto, para?: uuid|null }  (administrador) grava o aviso e envia (para vazio = todos do cliente)
//   { acao: 'pendentes' }                               (administrador) envia os avisos do sistema que ainda não saíram
//   { acao: 'rotina' } + cabeçalho x-rotina: <segredo>  (agendador do banco, de hora em hora) prazos de teste + pendentes
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-rotina',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const APP_URL = 'https://agaklik.github.io/levantamento_patrimonial/';
const dataBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

// ====================== Web Push (RFC 8291 + VAPID RFC 8292) ======================
// --- início do núcleo de envio (testado fora do Supabase) ---
const enc = new TextEncoder();
function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64u(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(t); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function juntar(...partes: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(chave: Uint8Array, dados: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', chave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dados));
}
type Vapid = { publica: string; privada: JsonWebKey };
async function gerarVapid(): Promise<Vapid> {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('raw', par.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', par.privateKey);
  return { publica: b64u(pub), privada: priv };
}
async function jwtVapid(endpoint: string, v: Vapid, sub: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const cab = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const corpo = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const k = await crypto.subtle.importKey('jwk', v.privada, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const ass = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, enc.encode(cab + '.' + corpo));
  return cab + '.' + corpo + '.' + b64u(ass);
}
// cifra a mensagem para o aparelho (aes128gcm, um registro só)
async function cifrar(texto: string, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPub = deB64u(p256dh), segredo = deB64u(auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(segredo, ecdh);
  const ikm = await hmac(prkKey, juntar(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, juntar(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, juntar(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const claro = juntar(enc.encode(texto), new Uint8Array([2]));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, claro));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return juntar(sal, rs, new Uint8Array([asPub.length]), asPub, cifrado);
}
type Inscricao = { endpoint: string; p256dh: string; auth: string };
// devolve o status HTTP do serviço de notificações do aparelho (201 = entregue)
async function enviarPush(sub: Inscricao, dados: unknown, v: Vapid, ttl = 86400): Promise<number> {
  const corpo = await cifrar(JSON.stringify(dados), sub.p256dh, sub.auth);
  const jwt = await jwtVapid(sub.endpoint, v, APP_URL);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': String(ttl), 'Urgency': 'normal', 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', 'Authorization': `vapid t=${jwt}, k=${v.publica}`,
    },
    body: corpo,
  });
  await r.arrayBuffer().catch(() => null);
  return r.status;
}
// --- fim do núcleo de envio ---

// ====================== banco ======================
async function vapid(adm: SupabaseClient): Promise<{ v: Vapid; segredo: string }> {
  const { data, error } = await adm.from('push_config').select('vapid_publica,vapid_privada,segredo_rotina').eq('id', 1).maybeSingle();
  if (error) throw new Error('Rode antes o script supabase/avisos.sql no SQL Editor.');
  if (data?.vapid_publica && data?.vapid_privada) return { v: { publica: data.vapid_publica, privada: data.vapid_privada }, segredo: data.segredo_rotina };
  const v = await gerarVapid();
  // se duas chamadas criarem ao mesmo tempo, fica a primeira que gravou
  await adm.from('push_config').update({ vapid_publica: v.publica, vapid_privada: v.privada }).eq('id', 1).is('vapid_publica', null);
  const { data: d2 } = await adm.from('push_config').select('vapid_publica,vapid_privada,segredo_rotina').eq('id', 1).single();
  return { v: { publica: d2!.vapid_publica, privada: d2!.vapid_privada }, segredo: d2!.segredo_rotina };
}

type Aviso = { id: number; cliente_id: number; para: string | null; titulo: string; texto: string; tipo: string; url: string | null };
// manda um aviso para os aparelhos de quem deve receber; devolve quantos aparelhos receberam
async function despachar(adm: SupabaseClient, v: Vapid, a: Aviso) {
  let alvo: string[];
  if (a.para) alvo = [a.para];
  else {
    const { data } = await adm.from('usuarios').select('user_id').eq('cliente_id', a.cliente_id).eq('ativo', true);
    alvo = (data ?? []).map((u) => u.user_id);
  }
  // preferências: sem linha = recebe tudo
  const { data: prefs } = await adm.from('avisos_pref').select('user_id,admin,sistema').in('user_id', alvo.length ? alvo : ['00000000-0000-0000-0000-000000000000']);
  const pref = new Map((prefs ?? []).map((p) => [p.user_id, p]));
  const querem = alvo.filter((id) => { const p = pref.get(id); return !p || (a.tipo === 'sistema' ? p.sistema : p.admin) !== false; });
  let entregues = 0, aparelhos = 0;
  if (querem.length) {
    const { data: subs } = await adm.from('push_inscricoes').select('endpoint,p256dh,auth,user_id').in('user_id', querem);
    aparelhos = (subs ?? []).length;
    const dados = { id: a.id, titulo: a.titulo, texto: a.texto, url: a.url || './#avisos', tipo: a.tipo };
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        const st = await enviarPush(s, dados, v);
        if (st >= 200 && st < 300) { entregues++; await adm.from('push_inscricoes').update({ ultimo_ok: new Date().toISOString(), falhas: 0 }).eq('endpoint', s.endpoint); }
        else if (st === 404 || st === 410) await adm.from('push_inscricoes').delete().eq('endpoint', s.endpoint); // aparelho saiu ou desinstalou
        else await adm.rpc('push_falhou', { p_endpoint: s.endpoint });
      } catch (_) { await adm.rpc('push_falhou', { p_endpoint: s.endpoint }); }
    }));
  }
  await adm.from('avisos').update({ enviado_em: new Date().toISOString(), entregues, pessoas: alvo.length, sem_notificacao: alvo.length - querem.length }).eq('id', a.id);
  return { entregues, aparelhos, pessoas: alvo.length, desligaram: alvo.length - querem.length };
}
async function despacharPendentes(adm: SupabaseClient, v: Vapid, cliente: number | null) {
  let q = adm.from('avisos').select('id,cliente_id,para,titulo,texto,tipo,url').is('enviado_em', null)
    .gt('criado_em', new Date(Date.now() - 2 * 86400000).toISOString()).order('id').limit(200);
  if (cliente != null) q = q.eq('cliente_id', cliente);
  const { data } = await q;
  let n = 0; for (const a of data ?? []) { await despachar(adm, v, a as Aviso); n++; }
  return n;
}
// avisos automáticos de prazo do acesso de teste (3 dias e 1 dia antes)
async function avisosDePrazo(adm: SupabaseClient) {
  const agora = Date.now();
  const { data } = await adm.from('usuarios').select('user_id,cliente_id,acesso_ate')
    .eq('ativo', true).not('acesso_ate', 'is', null)
    .gt('acesso_ate', new Date(agora).toISOString()).lt('acesso_ate', new Date(agora + 3 * 86400000).toISOString());
  const { data: cfgs } = await adm.from('configuracao').select('cliente_id,dados');
  const desligado = new Set((cfgs ?? []).filter((c) => c.dados?.avisosAuto?.prazo === false).map((c) => c.cliente_id));
  let n = 0;
  for (const u of data ?? []) {
    if (desligado.has(u.cliente_id)) continue;
    const falta = new Date(u.acesso_ate).getTime() - agora;
    const etapa = falta <= 86400000 ? 1 : 3;
    const { error } = await adm.from('avisos').insert({
      cliente_id: u.cliente_id, para: u.user_id, tipo: 'sistema', categoria: 'prazo',
      chave: `prazo${etapa}:${u.user_id}:${u.acesso_ate}`,
      titulo: etapa === 1 ? 'Seu acesso de teste termina amanhã' : 'Seu acesso de teste está terminando',
      texto: `O período de teste vale até ${dataBR(u.acesso_ate)}, às 23h59. Para continuar, fale com quem liberou o seu acesso.`,
      criado_nome: 'Sistema',
    });
    if (!error) n++; // chave repetida = já avisado nesta etapa
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adm = createClient(url, service, { auth: { persistSession: false } });
    const b = await req.json().catch(() => ({}));
    const { v, segredo } = await vapid(adm);

    if (b.acao === 'chave') return json({ publica: v.publica });

    if (b.acao === 'rotina') {
      if (!segredo || req.headers.get('x-rotina') !== segredo) return json({ erro: 'Não autorizado.' }, 401);
      const prazos = await avisosDePrazo(adm);
      const enviados = await despacharPendentes(adm, v, null);
      // aparelhos que falham há muito tempo saem da lista
      await adm.from('push_inscricoes').delete().gte('falhas', 20);
      return json({ ok: true, prazos, enviados });
    }

    // ---------- daqui em diante, só com login ----------
    const asUser = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ erro: 'Sessão inválida. Entre de novo.' }, 401);
    const { data: ativo } = await asUser.rpc('usuario_ativo');
    if (ativo !== true) return json({ erro: 'Usuário sem acesso.' }, 403);

    if (b.acao === 'teste') {
      const { data: subs } = await adm.from('push_inscricoes').select('endpoint,p256dh,auth').eq('user_id', user.id);
      let ok = 0;
      for (const s of subs ?? []) {
        const st = await enviarPush(s, { titulo: 'Notificações ligadas', texto: 'Você vai receber aqui os avisos do levantamento.', url: './#avisos', tipo: 'teste' }, v, 600).catch(() => 0);
        if (st >= 200 && st < 300) ok++; else if (st === 404 || st === 410) await adm.from('push_inscricoes').delete().eq('endpoint', s.endpoint);
      }
      return json({ ok: true, aparelhos: (subs ?? []).length, entregues: ok });
    }

    const { data: ehAdmin } = await asUser.rpc('is_admin');
    if (ehAdmin !== true) return json({ erro: 'Apenas administradores enviam avisos.' }, 403);
    const { data: cli } = await asUser.rpc('cliente_atual');
    const cliente: number | null = typeof cli === 'number' ? cli : null;
    if (cliente == null) return json({ erro: 'Escolha antes o cliente em que você está trabalhando.' }, 400);

    if (b.acao === 'destinatarios') {
      const { data: us } = await adm.from('usuarios').select('user_id,nome,usuario,ativo,geral').eq('cliente_id', cliente).eq('ativo', true).order('nome');
      const ids = (us ?? []).map((u) => u.user_id);
      const vazio = ['00000000-0000-0000-0000-000000000000'];
      const { data: subs } = await adm.from('push_inscricoes').select('user_id,aparelho,ultimo_ok').in('user_id', ids.length ? ids : vazio);
      const { data: prefs } = await adm.from('avisos_pref').select('user_id,admin,sistema').in('user_id', ids.length ? ids : vazio);
      const pref = new Map((prefs ?? []).map((p) => [p.user_id, p]));
      return json({
        usuarios: (us ?? []).map((u) => ({
          id: u.user_id, nome: u.nome || u.usuario || '(sem nome)', geral: u.geral === true,
          aparelhos: (subs ?? []).filter((s) => s.user_id === u.user_id).map((s) => s.aparelho || 'aparelho'),
          admin: pref.get(u.user_id)?.admin !== false, sistema: pref.get(u.user_id)?.sistema !== false,
        })),
      });
    }

    if (b.acao === 'enviar') {
      const titulo = String(b.titulo ?? '').trim().slice(0, 80);
      const texto = String(b.texto ?? '').trim().slice(0, 600);
      if (!titulo || !texto) return json({ erro: 'Escreva o título e a mensagem.' }, 400);
      let para: string | null = b.para ? String(b.para) : null;
      if (para) {
        const { data: alvo } = await adm.from('usuarios').select('cliente_id').eq('user_id', para).maybeSingle();
        if (!alvo || alvo.cliente_id !== cliente) return json({ erro: 'Este usuário não pertence ao cliente em que você está.' }, 403);
      }
      const { data: eu } = await adm.from('usuarios').select('nome').eq('user_id', user.id).maybeSingle();
      const { data: a, error } = await adm.from('avisos').insert({
        cliente_id: cliente, para, titulo, texto, tipo: 'admin', categoria: 'mensagem',
        criado_por: user.id, criado_nome: eu?.nome || user.email,
      }).select('id,cliente_id,para,titulo,texto,tipo,url').single();
      if (error) throw error;
      const r = await despachar(adm, v, a as Aviso);
      return json({ ok: true, id: a!.id, ...r });
    }

    if (b.acao === 'pendentes') return json({ ok: true, enviados: await despacharPendentes(adm, v, cliente) });

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});

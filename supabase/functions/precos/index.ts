// Função "precos": pesquisa de preços de referência para a reavaliação.
// Consulta a API pública de dados abertos do Compras.gov.br (sem chave):
//   1) catálogo de materiais (CATMAT), para achar o código do item pela descrição;
//   2) pesquisa de preço, com os preços homologados em compras públicas desse item.
// O navegador não chama a API direto (CORS e lentidão); esta função faz a consulta,
// guarda o resultado por 24 horas na tabela precos_cache e devolve uma lista limpa.
//
// IMPORTANTE: no painel do Supabase, em Edge Functions > precos > Details,
// deixe DESLIGADO "Verify JWT" (como na função usuarios). A sessão é conferida aqui
// dentro, e só administradores podem pesquisar (função is_admin() do seguranca.sql).
//
// Ações (corpo JSON):
//   { acao: 'catalogo', texto }                          -> itens do CATMAT parecidos com o texto
//   { acao: 'precos', codigo, ufs: ['RS',...], meses }   -> preços do item (ufs vazio = Brasil inteiro)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const API = 'https://dadosabertos.compras.gov.br';
const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ');
const CACHE_HORAS = 24;
const POR_PAGINA = 500;

type Bruto = Record<string, unknown>;

async function buscar(caminho: string, params: Record<string, string | number>) {
  const u = new URL(API + caminho);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 40000);
  try {
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: ctl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Compras.gov.br respondeu ${r.status}: ${txt.slice(0, 200)}`);
    const d = txt ? JSON.parse(txt) : {};
    const lista: Bruto[] = Array.isArray(d) ? d : (d.resultado ?? d.data ?? d.content ?? []);
    const totalPaginas = Number(d.totalPaginas ?? d.totalPages ?? 1) || 1;
    const totalRegistros = Number(d.totalRegistros ?? d.totalElements ?? lista.length) || lista.length;
    return { lista, totalPaginas, totalRegistros };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('O Compras.gov.br demorou demais para responder. Tente de novo.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const txt = (v: unknown) => (v == null ? '' : String(v).trim());
function numero(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function data(v: unknown): string | null {
  const s = txt(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
const pega = (o: Bruto, ...ks: string[]) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };

function limparPreco(o: Bruto) {
  return {
    id_compra: txt(pega(o, 'idCompra')),
    item: txt(pega(o, 'numeroItemCompra', 'idItemCompra')),
    descricao: txt(pega(o, 'descricaoItem')),
    valor: numero(pega(o, 'precoUnitario', 'valorUnitario', 'valorUnitarioHomologado')),
    quantidade: numero(pega(o, 'quantidade')),
    unidade: txt(pega(o, 'siglaUnidadeFornecimento', 'nomeUnidadeFornecimento', 'siglaUnidadeMedida', 'nomeUnidadeMedida')),
    data: data(pega(o, 'dataResultado', 'dataCompra', 'dataHoraAtualizacaoItem', 'dataHoraAtualizacaoCompra')),
    orgao: txt(pega(o, 'nomeOrgao', 'nomeUasg')),
    uasg: txt(pega(o, 'nomeUasg')),
    codigo_uasg: txt(pega(o, 'codigoUasg')),
    municipio: txt(pega(o, 'municipio', 'nomeMunicipio')),
    uf: txt(pega(o, 'estado', 'siglaUf', 'uf')).toUpperCase(),
    esfera: txt(pega(o, 'esfera')),
    modalidade: txt(pega(o, 'modalidade', 'nomeModalidade')),
    fornecedor: txt(pega(o, 'nomeFornecedor')),
    marca: txt(pega(o, 'marca')),
  };
}

// páginas a ler por estado: a 1ª e as 2 últimas (a ordem da API não é documentada;
// assim pegamos tanto as compras mais antigas quanto as mais recentes)
async function precosDoEstado(adm: ReturnType<typeof createClient>, codigo: string, uf: string) {
  const chave = `compras:${codigo}:${uf || 'BR'}`;
  const { data: c } = await adm.from('precos_cache').select('resposta,criado_em').eq('chave', chave).maybeSingle();
  if (c && Date.now() - new Date(c.criado_em as string).getTime() < CACHE_HORAS * 3600e3) return c.resposta as { itens: unknown[]; total: number };

  const base: Record<string, string | number> = { tamanhoPagina: POR_PAGINA, codigoItemCatalogo: codigo };
  if (uf) base.estado = uf;
  const p1 = await buscar('/modulo-pesquisa-preco/1_consultarMaterial', { ...base, pagina: 1 });
  const paginas = [...new Set([p1.totalPaginas - 1, p1.totalPaginas].filter((p) => p > 1))];
  const outras = await Promise.all(paginas.map((p) => buscar('/modulo-pesquisa-preco/1_consultarMaterial', { ...base, pagina: p })));
  const brutos = [p1, ...outras].flatMap((x) => x.lista);
  const itens = brutos.map(limparPreco).filter((x) => x.valor != null && x.valor > 0);
  const resposta = { itens, total: p1.totalRegistros, paginas: p1.totalPaginas, lidas: [1, ...paginas] };
  await adm.from('precos_cache').upsert({
    chave, resposta, amostra: brutos.slice(0, 3), criado_em: new Date().toISOString(),
  });
  return resposta;
}

async function emParalelo<T, R>(lista: T[], n: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(lista.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (i < lista.length) { const k = i++; out[k] = await f(lista[k]); }
  }));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const adm = createClient(url, service, { auth: { persistSession: false } });

    const asUser = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ erro: 'Sessão inválida. Entre de novo.' }, 401);
    const { data: ehAdmin } = await asUser.rpc('is_admin');
    if (ehAdmin !== true) return json({ erro: 'Apenas administradores podem pesquisar preços.' }, 403);

    const b = await req.json().catch(() => ({}));

    if (b.acao === 'catalogo') {
      const texto = txt(b.texto).slice(0, 120);
      if (texto.length < 3) return json({ erro: 'Digite ao menos 3 letras.' }, 400);
      // código CATMAT digitado direto
      if (/^\d{3,9}$/.test(texto)) {
        const r = await buscar('/modulo-material/4_consultarItemMaterial', { pagina: 1, tamanhoPagina: 10, codigoItem: texto });
        return json({ itens: r.lista.map(limparItem) });
      }
      const r = await buscar('/modulo-material/4_consultarItemMaterial', { pagina: 1, tamanhoPagina: 200, descricaoItem: texto });
      const itens = r.lista.map(limparItem).filter((x) => x.ativo !== false);
      await adm.from('precos_cache').upsert({
        chave: 'catalogo:' + texto.toLowerCase(), resposta: { total: r.totalRegistros, n: itens.length },
        amostra: r.lista.slice(0, 3), criado_em: new Date().toISOString(),
      });
      return json({ itens, total: r.totalRegistros });
    }

    if (b.acao === 'precos') {
      const codigo = txt(b.codigo);
      if (!/^\d{1,9}$/.test(codigo)) return json({ erro: 'Código do item (CATMAT) inválido.' }, 400);
      const ufs: string[] = Array.isArray(b.ufs) ? [...new Set(b.ufs.map((u: unknown) => txt(u).toUpperCase()).filter((u: string) => UFS.includes(u)))] as string[] : [];
      const meses = Math.min(60, Math.max(1, Number(b.meses) || 12));
      const desde = new Date(); desde.setMonth(desde.getMonth() - meses);
      const desdeISO = desde.toISOString().slice(0, 10);

      const partes = await emParalelo(ufs.length ? ufs : [''], 4, (uf) => precosDoEstado(adm, codigo, uf));
      const vistos = new Set<string>();
      type P = ReturnType<typeof limparPreco>;
      const todos = partes.flatMap((p) => p.itens as P[]);
      const itens = todos
        .filter((x) => !x.data || x.data >= desdeISO)
        .filter((x) => { const k = `${x.id_compra}|${x.item}|${x.fornecedor}|${x.valor}`; if (vistos.has(k)) return false; vistos.add(k); return true; })
        .sort((a, c) => (c.data || '').localeCompare(a.data || ''));
      return json({
        itens: itens.slice(0, 400),
        encontrados: itens.length,
        fora_do_periodo: todos.length - itens.length,
        total_na_fonte: partes.reduce((s, p) => s + (p.total || 0), 0),
        desde: desdeISO,
        consultado_em: new Date().toISOString(),
      });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});

function limparItem(o: Bruto) {
  return {
    codigo: txt(pega(o, 'codigoItem', 'codigo')),
    descricao: txt(pega(o, 'descricaoItem', 'descricao')),
    pdm: txt(pega(o, 'nomePdm', 'descricaoPdm')),
    classe: txt(pega(o, 'nomeClasse', 'descricaoClasse')),
    ativo: o.statusItem == null ? true : !(o.statusItem === false || o.statusItem === 'false' || o.statusItem === 0),
  };
}

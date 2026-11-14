// Função "precos": pesquisa de preços de referência para a reavaliação.
// Consulta a API pública de dados abertos do Compras.gov.br (sem chave):
//   - modulo-material/3_consultarPdmMaterial: lista dos tipos de material (PDM), que a
//     função copia para a tabela catmat_pdm, porque a API não tem busca por palavra;
//   - modulo-pesquisa-preco/1_consultarMaterial: preços homologados em compras públicas,
//     por tipo de material (codigoPdm) ou por item do catálogo (codigoItemCatalogo),
//     com filtro de estado e de data da compra.
// O resultado de cada consulta fica 24 horas na tabela precos_cache.
//
// IMPORTANTE: no painel do Supabase, em Edge Functions > precos > Details,
// deixe DESLIGADO "Verify JWT" (como na função usuarios). A sessão é conferida aqui
// dentro, e só administradores podem pesquisar (função is_admin() do seguranca.sql).
//
// Ações (corpo JSON):
//   { acao: 'catalogo', texto }                    -> tipos de material parecidos com o texto
//                                                     (ou o item, se o texto for um código CATMAT)
//   { acao: 'indexar', pagina }                    -> copia uma página (500) de tipos de material
//   { acao: 'precos', tipo, codigo, ufs, meses }   -> preços (tipo 'codigoPdm' | 'codigoItemCatalogo';
//                                                     ufs vazio = Brasil inteiro)
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
const MAX_PAGINAS = 4; // até 2.000 preços por estado (ou pelo Brasil)

type Bruto = Record<string, unknown>;

async function buscar(caminho: string, params: Record<string, string | number | boolean>) {
  const u = new URL(API + caminho);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: ctl.signal });
    const corpo = await r.text();
    if (!r.ok) throw new Error(`Compras.gov.br respondeu ${r.status}: ${corpo.slice(0, 200)}`);
    const d = corpo ? JSON.parse(corpo) : {};
    const lista: Bruto[] = Array.isArray(d) ? d : (d.resultado ?? []);
    return { lista, totalPaginas: Number(d.totalPaginas ?? 1) || 0, totalRegistros: Number(d.totalRegistros ?? lista.length) || 0 };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('O Compras.gov.br demorou demais para responder. Tente de novo.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const txt = (v: unknown) => (v == null ? '' : String(v).trim());
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function numero(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
const data = (v: unknown) => { const m = txt(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const ESFERA: Record<string, string> = { F: 'Federal', E: 'Estadual', M: 'Municipal', D: 'Distrital' };

function limparPreco(o: Bruto) {
  return {
    id_compra: txt(o.idCompra),
    item: txt(o.numeroItemCompra),
    catmat: txt(o.codigoItemCatalogo),
    descricao: txt(o.descricaoItem).slice(0, 400),
    valor: numero(o.precoUnitario),
    quantidade: numero(o.quantidade),
    unidade: txt(o.siglaUnidadeFornecimento || o.nomeUnidadeFornecimento || o.siglaUnidadeMedida),
    data: data(o.dataCompra) || data(o.dataResultado),
    orgao: txt(o.nomeOrgao),
    uasg: txt(o.nomeUasg),
    codigo_uasg: txt(o.codigoUasg),
    municipio: txt(o.municipio),
    uf: txt(o.estado).toUpperCase(),
    esfera: ESFERA[txt(o.esfera)] || txt(o.esfera),
    fornecedor: txt(o.nomeFornecedor),
    marca: txt(o.marca),
    objeto: txt(o.objetoCompra).slice(0, 200),
  };
}

async function precosDoEstado(adm: ReturnType<typeof createClient>, tipo: string, codigo: string, uf: string, inicio: string, fim: string) {
  const chave = `compras:${tipo}:${codigo}:${uf || 'BR'}:${inicio}`;
  const { data: c } = await adm.from('precos_cache').select('resposta,criado_em').eq('chave', chave).maybeSingle();
  if (c && Date.now() - new Date(c.criado_em as string).getTime() < CACHE_HORAS * 3600e3) return c.resposta as { itens: ReturnType<typeof limparPreco>[]; total: number };

  const base: Record<string, string | number> = { tamanhoPagina: POR_PAGINA, tipo, codigo, dataCompraInicio: inicio, dataCompraFim: fim };
  if (uf) base.estado = uf;
  const p1 = await buscar('/modulo-pesquisa-preco/1_consultarMaterial', { ...base, pagina: 1 });
  const extras = Array.from({ length: Math.min(p1.totalPaginas, MAX_PAGINAS) - 1 }, (_, i) => i + 2);
  const outras = await Promise.all(extras.map((p) => buscar('/modulo-pesquisa-preco/1_consultarMaterial', { ...base, pagina: p })));
  const brutos = [p1, ...outras].flatMap((x) => x.lista);
  const itens = brutos.map(limparPreco).filter((x) => x.valor != null && x.valor > 0);
  const resposta = { itens, total: p1.totalRegistros };
  await adm.from('precos_cache').upsert({ chave, resposta, amostra: brutos.slice(0, 2), criado_em: new Date().toISOString() });
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

const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'para', 'por', 'em', 'e', 'ou', 'tipo', 'uso']);
const raiz = (w: string) => (w.length > 4 ? w.replace(/(oes|aes|ais|eis|es|s)$/, '') : w);

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

    // ---------- copia a lista de tipos de material (PDM), uma página por chamada ----------
    if (b.acao === 'indexar') {
      const pagina = Math.max(1, Number(b.pagina) || 1);
      const r = await buscar('/modulo-material/3_consultarPdmMaterial', { pagina, tamanhoPagina: POR_PAGINA });
      const linhas = r.lista.map((o) => ({
        codigo: Number(o.codigoPdm), nome: txt(o.nomePdm).replace(/^"|"$/g, ''),
        codigo_classe: Number(o.codigoClasse) || null, classe: txt(o.nomeClasse), grupo: txt(o.nomeGrupo),
        ativo: o.statusPdm !== false, busca: semAcento(`${txt(o.nomePdm)} ${txt(o.nomeClasse)}`),
      })).filter((x) => x.codigo);
      if (linhas.length) {
        const { error } = await adm.from('catmat_pdm').upsert(linhas);
        if (error) throw new Error('Erro ao gravar o catálogo: ' + error.message + ' (o script precos.sql foi executado?)');
      }
      return json({ pagina, totalPaginas: r.totalPaginas, gravados: linhas.length });
    }

    // ---------- busca no catálogo ----------
    if (b.acao === 'catalogo') {
      const texto = txt(b.texto).slice(0, 120);
      if (/^\d{3,9}$/.test(texto)) {
        const r = await buscar('/modulo-material/4_consultarItemMaterial', { pagina: 1, tamanhoPagina: 10, codigoItem: texto });
        return json({ itens: r.lista.map((o) => ({ tipo: 'codigoItemCatalogo', codigo: txt(o.codigoItem), nome: txt(o.descricaoItem), classe: txt(o.nomeClasse), grupo_pdm: txt(o.nomePdm), ativo: o.statusItem !== false })) });
      }
      const { count } = await adm.from('catmat_pdm').select('codigo', { count: 'exact', head: true });
      if (!count) return json({ indexar: true, itens: [] });
      const palavras = [...new Set(semAcento(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w)).map(raiz))];
      if (!palavras.length) return json({ erro: 'Digite ao menos uma palavra com 3 letras.' }, 400);
      const { data: cand, error } = await adm.from('catmat_pdm').select('codigo,nome,classe,ativo,busca')
        .or(palavras.map((w) => `busca.ilike.*${w}*`).join(',')).limit(1000);
      if (error) throw new Error(error.message);
      const lista = (cand || []).map((x) => {
        const nome = semAcento(x.nome as string);
        const noNome = palavras.filter((w) => nome.includes(w)).length;
        const naClasse = palavras.filter((w) => (x.busca as string).includes(w)).length;
        const comeca = nome.startsWith(palavras[0]) ? 1 : 0;
        return { ...x, pontos: noNome * 10 + naClasse * 2 + comeca * 5 + (x.ativo ? 3 : 0) - nome.length / 100 };
      }).sort((a, c) => c.pontos - a.pontos).slice(0, 60);
      return json({
        itens: lista.map((x) => ({ tipo: 'codigoPdm', codigo: String(x.codigo), nome: x.nome, classe: x.classe, ativo: x.ativo })),
        palavras,
      });
    }

    // ---------- preços ----------
    if (b.acao === 'precos') {
      const tipo = b.tipo === 'codigoItemCatalogo' ? 'codigoItemCatalogo' : 'codigoPdm';
      const codigo = txt(b.codigo);
      if (!/^\d{1,9}$/.test(codigo)) return json({ erro: 'Código inválido.' }, 400);
      const ufs: string[] = Array.isArray(b.ufs) ? [...new Set((b.ufs as unknown[]).map((u) => txt(u).toUpperCase()).filter((u) => UFS.includes(u)))] : [];
      const meses = Math.min(60, Math.max(1, Number(b.meses) || 12));
      const hoje = new Date();
      const desde = new Date(hoje); desde.setMonth(desde.getMonth() - meses);
      const inicio = desde.toISOString().slice(0, 10), fim = hoje.toISOString().slice(0, 10);

      const partes = await emParalelo(ufs.length ? ufs : [''], 4, (uf) => precosDoEstado(adm, tipo, codigo, uf, inicio, fim));
      const vistos = new Set<string>();
      const itens = partes.flatMap((p) => p.itens)
        .filter((x) => { const k = `${x.id_compra}|${x.item}|${x.fornecedor}|${x.valor}`; if (vistos.has(k)) return false; vistos.add(k); return true; })
        .sort((a, c) => (c.data || '').localeCompare(a.data || ''));
      const total = partes.reduce((s, p) => s + (p.total || 0), 0);
      return json({ itens: itens.slice(0, 1500), encontrados: itens.length, total_na_fonte: total, desde: inicio, consultado_em: new Date().toISOString() });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});

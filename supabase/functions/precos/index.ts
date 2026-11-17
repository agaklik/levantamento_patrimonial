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
//   { acao: 'pncp', texto, ufs, meses }            -> preços no PNCP pela descrição
//   { acao: 'lc_orgaos' }                          -> órgãos do LicitaCon já carregados
//   { acao: 'lc_procurar', texto }                 -> órgãos do RS pelo nome ou município
//   { acao: 'lc_carregar', cd_orgao }              -> baixa o ZIP do órgão no TCE-RS e guarda os itens
//   { acao: 'lc_remover', cd_orgao }               -> tira o órgão da lista de referência
//   { acao: 'licitacon', texto, orgaos, meses }    -> preços nos órgãos carregados pela descrição
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Unzip, UnzipInflate } from 'npm:fflate@0.8.2';

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

// ---------- PNCP (Portal Nacional de Contratações Públicas): prefeituras, estados e União ----------
// O PNCP não tem pesquisa de preços por catálogo. O caminho é: a busca por texto do portal acha as
// contratações com resultado; de cada uma leem-se os itens; dos itens cuja descrição tem as palavras
// pesquisadas lê-se o valor unitário homologado (ou, se não houver, o estimado, marcado como tal).
const PNCP = 'https://pncp.gov.br';
const PNCP_COMPRAS = 15;      // contratações lidas por pesquisa
const PNCP_RESULTADOS = 40;   // itens em que se busca o valor homologado
async function pncpJson(caminho: string, params: Record<string, string | number> = {}) {
  const u = new URL(PNCP + caminho);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 204 || r.status === 404) return null;
    const corpo = await r.text();
    if (!r.ok) throw new Error(`O PNCP respondeu ${r.status}: ${corpo.slice(0, 160)}`);
    return corpo ? JSON.parse(corpo) : null;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('O PNCP demorou demais para responder. Tente de novo.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}
type ItemPncp = ReturnType<typeof limparPreco> & { estimado: boolean; link: string; fonte: string };
async function precosPncp(adm: ReturnType<typeof createClient>, texto: string, ufs: string[], meses: number) {
  const palavras = [...new Set(semAcento(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w)).map(raiz))];
  if (!palavras.length) throw new Error('Digite ao menos uma palavra com 3 letras.');
  const chave = `pncp:${palavras.join('+')}:${ufs.join('|') || 'BR'}:${meses}:${new Date().toISOString().slice(0, 10)}`;
  const { data: c } = await adm.from('precos_cache').select('resposta').eq('chave', chave).maybeSingle();
  if (c) return c.resposta as { itens: ItemPncp[]; compras: number; achadas: number };

  const desde = new Date(); desde.setMonth(desde.getMonth() - meses);
  const filtros: Record<string, string | number> = { q: semAcento(texto), tipos_documento: 'edital', ordenacao: '-data', pagina: 1, tam_pagina: 50, status: 'encerradas' };
  if (ufs.length) filtros.ufs = ufs.join('|');
  const busca = await pncpJson('/api/search/', filtros);
  const achadas: Bruto[] = (busca?.items ?? []) as Bruto[];
  const compras = achadas.filter((h) => h.tem_resultado === true && h.cancelado !== true && txt(h.orgao_cnpj) && txt(h.ano) && txt(h.numero_sequencial)
    && (data(h.data_publicacao_pncp) ?? '9999') >= desde.toISOString().slice(0, 10)).slice(0, PNCP_COMPRAS);

  const candidatos: { h: Bruto; it: Bruto }[] = [];
  let amostra: Bruto[] = [];
  await emParalelo(compras, 5, async (h) => {
    try {
      const itens = await pncpJson(`/api/pncp/v1/orgaos/${txt(h.orgao_cnpj)}/compras/${txt(h.ano)}/${txt(h.numero_sequencial)}/itens`, { pagina: 1, tamanhoPagina: 100 });
      for (const it of (Array.isArray(itens) ? itens : []) as Bruto[]) {
        const d = semAcento(txt(it.descricao));
        if (palavras.every((w) => d.includes(w))) candidatos.push({ h, it });
      }
      if (!amostra.length && Array.isArray(itens) && itens.length) amostra = [h, itens[0] as Bruto];
    } catch (_) { /* uma contratação que falha não derruba a pesquisa */ }
  });

  let comResultado = 0;
  const itens = (await emParalelo(candidatos, 6, async ({ h, it }): Promise<ItemPncp | null> => {
    let valor = numero(it.valorUnitarioEstimado), qtd = numero(it.quantidade), fornecedor = '', quando = data(h.data_publicacao_pncp), estimado = true;
    if (it.temResultado === true && comResultado < PNCP_RESULTADOS) {
      comResultado++;
      try {
        const rs = await pncpJson(`/api/pncp/v1/orgaos/${txt(h.orgao_cnpj)}/compras/${txt(h.ano)}/${txt(h.numero_sequencial)}/itens/${txt(it.numeroItem)}/resultados`);
        const r = ((Array.isArray(rs) ? rs : []) as Bruto[]).filter((x) => !x.dataCancelamento && numero(x.valorUnitarioHomologado))
          .sort((a, b2) => (Number(a.ordemClassificacaoSrp) || 1) - (Number(b2.ordemClassificacaoSrp) || 1))[0];
        if (r) { valor = numero(r.valorUnitarioHomologado); qtd = numero(r.quantidadeHomologada) ?? qtd; fornecedor = txt(r.nomeRazaoSocialFornecedor); quando = data(r.dataResultado) || quando; estimado = false; }
      } catch (_) { /* fica o valor estimado */ }
    }
    if (valor == null || valor <= 0) return null;
    return {
      id_compra: txt(h.numero_controle_pncp), item: txt(it.numeroItem), catmat: txt(it.catalogoCodigoItem),
      descricao: txt(it.descricao).slice(0, 400), valor, quantidade: qtd, unidade: txt(it.unidadeMedida), data: quando,
      orgao: txt(h.orgao_nome), uasg: txt(h.unidade_nome), codigo_uasg: txt(h.unidade_codigo), municipio: txt(h.municipio_nome), uf: txt(h.uf).toUpperCase(),
      esfera: txt(h.esfera_nome), fornecedor, marca: '', objeto: txt(h.description).slice(0, 200),
      estimado, fonte: 'PNCP', link: `${PNCP}/app/editais/${txt(h.orgao_cnpj)}/${txt(h.ano)}/${txt(h.numero_sequencial)}`,
    };
  })).filter((x): x is ItemPncp => !!x).sort((a, c2) => (c2.data || '').localeCompare(a.data || ''));

  const resposta = { itens, compras: compras.length, achadas: Number(busca?.total ?? achadas.length) || 0 };
  await adm.from('precos_cache').upsert({ chave, resposta, amostra, criado_em: new Date().toISOString() });
  return resposta;
}


// ---------- LicitaCon (TCE-RS): licitações dos órgãos gaúchos ----------
// O TCE-RS publica um ZIP por órgão com todas as licitações (CSV), sem busca por palavra.
// A função baixa o ZIP dos órgãos escolhidos (lendo direto do download, sem guardar o arquivo),
// fica com os itens de valor unitário homologado dos últimos 3 anos e grava em licitacon_itens.
const TCE = 'https://dados.tce.rs.gov.br/dados';
const LC_ANOS = 3;
const MODALIDADE: Record<string, string> = {
  PRD: 'Dispensa', PRI: 'Inexigibilidade', PRP: 'Pregão presencial', PRE: 'Pregão eletrônico',
  TMP: 'Tomada de preços', CNV: 'Convite', CNC: 'Concorrência', LEI: 'Leilão', RPO: 'Adesão a ata de registro de preços',
};

// leitor de CSV que recebe o texto em pedaços (aspas, vírgulas e quebras de linha dentro de campos).
// filtro(linha) opcional descarta a linha bruta antes de separar os campos, para gastar menos CPU.
function camposCsv(l: string): string[] {
  if (l.indexOf('"') < 0) return l.split(',');
  const out: string[] = [];
  let i = 0;
  while (i <= l.length) {
    if (l.charCodeAt(i) === 34) {
      let v = '', j = i + 1;
      for (;;) {
        const q = l.indexOf('"', j);
        if (q < 0) { v += l.slice(j); i = l.length + 1; break; }
        v += l.slice(j, q);
        if (l.charCodeAt(q + 1) === 34) { v += '"'; j = q + 2; continue; }
        const k = l.indexOf(',', q + 1);
        i = k < 0 ? l.length + 1 : k + 1; break;
      }
      out.push(v);
    } else {
      const k = l.indexOf(',', i);
      if (k < 0) { out.push(l.slice(i)); break; }
      out.push(l.slice(i, k)); i = k + 1;
    }
  }
  return out;
}
function leitorCsv(aoLer: (campos: string[]) => void, filtro?: (linha: string) => boolean) {
  let resto = '', primeira = true;
  const linha = (l: string) => {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (primeira) { primeira = false; aoLer(camposCsv(l.replace(/^\uFEFF/, ''))); return; }
    if (!l || (filtro && !filtro(l))) return;
    aoLer(camposCsv(l));
  };
  return (pedaco: string, fim = false) => {
    let txt = resto + pedaco, ini = 0, aspas = 0;
    for (;;) {
      const n = txt.indexOf('\n', ini);
      if (n < 0) break;
      // conta as aspas desde o começo da linha: número ímpar = a quebra está dentro de um campo
      for (let q = txt.indexOf('"', ini); q >= 0 && q < n; q = txt.indexOf('"', q + 1)) aspas++;
      if (aspas % 2) { ini = n + 1; continue; }
      linha(txt.slice(0, n)); txt = txt.slice(n + 1); ini = 0; aspas = 0;
    }
    resto = txt;
    if (fim && resto) { linha(resto); resto = ''; }
  };
}

// baixa o ZIP e entrega as linhas dos CSV pedidos (primeira linha = cabeçalho, sem BOM)
type LeitorArquivo = { linha: (campos: string[]) => void; filtro?: (linha: string) => boolean };
async function lerZipTce(url: string, arquivos: Record<string, LeitorArquivo>) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) throw new Error('O TCE-RS não tem arquivo do LicitaCon para este órgão.');
    if (!r.ok || !r.body) throw new Error(`O site do TCE-RS respondeu ${r.status}.`);
    const tam = Number(r.headers.get('content-length') || 0);
    if (tam > 20e6) throw new Error('O arquivo deste órgão é grande demais para carregar aqui (mais de 20 MB, como o de Porto Alegre). Escolha órgãos menores, como prefeituras vizinhas.');
    const erros: Error[] = [];
    const uz = new Unzip();
    uz.register(UnzipInflate);
    uz.onfile = (f) => {
      const nome = f.name.toLowerCase().split('/').pop() || '';
      const destino = arquivos[nome];
      if (!destino) return;
      const dec = new TextDecoder('utf-8');
      const csv = leitorCsv(destino.linha, destino.filtro);
      f.ondata = (err, dados, final) => {
        if (err) { erros.push(err); return; }
        try { csv(dec.decode(dados, { stream: !final }), final); } catch (e) { erros.push(e as Error); }
      };
      f.start();
    };
    for await (const pedaco of r.body) uz.push(pedaco);
    uz.push(new Uint8Array(0), true);
    if (erros.length) throw erros[0];
    return r.headers.get('last-modified') || '';
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('O site do TCE-RS demorou demais para responder. Tente de novo.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function listaOrgaosTce(adm: ReturnType<typeof createClient>) {
  const chave = 'licitacon:orgaos';
  const { data: c } = await adm.from('precos_cache').select('resposta,criado_em').eq('chave', chave).maybeSingle();
  if (c && Date.now() - new Date(c.criado_em as string).getTime() < 30 * 24 * 3600e3) return c.resposta as { cd: number; nome: string; municipio: string; ativo: boolean; tipo: string }[];
  const r = await fetch(`${TCE}/auxiliar/orgaos_auditados_rs.csv`);
  if (!r.ok) throw new Error(`O site do TCE-RS respondeu ${r.status} ao pedir a lista de órgãos.`);
  const linhas: string[][] = [];
  leitorCsv((c) => linhas.push(c))(await r.text(), true);
  const cab = linhas.shift()!.map((h) => h.replace(/^\uFEFF/, ''));
  const i = (n: string) => cab.indexOf(n);
  const lista = linhas.filter((c) => c.length > 3).map((c) => ({
    cd: Number(c[i('CD_ORGAO')]), nome: txt(c[i('NOME_ORGAO')]), municipio: txt(c[i('NOME_MUNICIPIO')]),
    ativo: txt(c[i('SITUACAO_ORGAO')]).startsWith('1'), tipo: txt(c[i('SETOR_GOVERNAMENTAL')]),
  })).filter((x) => x.cd);
  await adm.from('precos_cache').upsert({ chave, resposta: lista, amostra: null, criado_em: new Date().toISOString() });
  return lista;
}

async function carregarOrgaoLc(adm: ReturnType<typeof createClient>, cd: number) {
  const org = (await listaOrgaosTce(adm)).find((o) => o.cd === cd);
  if (!org) throw new Error('Órgão não encontrado na lista do TCE-RS.');
  const anoMin = new Date().getFullYear() - LC_ANOS;
  const desde = new Date(); desde.setFullYear(desde.getFullYear() - LC_ANOS);
  const desdeTxt = desde.toISOString().slice(0, 10);

  type Lic = { data: string | null; objeto: string; link: string; nome: string };
  const lics = new Map<string, Lic>();
  const pessoas = new Map<string, string>();
  const itens: string[][] = [];
  let cabItem: string[] = [], cabLic: string[] = [], cabPes: string[] = [];

  // o ano da licitação é o 3º campo das duas tabelas: descarta os anos antigos antes de separar os campos
  const anoRecente = (l: string) => {
    const a = l.indexOf(','), b2 = l.indexOf(',', a + 1), c = l.indexOf(',', b2 + 1);
    return Number(l.slice(b2 + 1, c)) >= anoMin - 1;
  };
  const quando = await lerZipTce(`${TCE}/licitacon/licitacao/orgao/${cd}.csv.zip`, {
    'licitacao.csv': {
      filtro: (l) => { const a = l.indexOf(','), b2 = l.indexOf(',', a + 1), c = l.indexOf(',', b2 + 1), d = l.indexOf(',', c + 1); return l.slice(0, d).includes('"') || Number(l.slice(c + 1, d)) >= anoMin - 1; },
      linha: (c) => {
        if (!cabLic.length) { cabLic = c; return; }
        const g = (n: string) => txt(c[cabLic.indexOf(n)]);
        lics.set(`${g('NR_LICITACAO')}|${g('ANO_LICITACAO')}|${g('CD_TIPO_MODALIDADE')}`, {
          data: data(g('DT_HOMOLOGACAO')) || data(g('DT_ADJUDICACAO')) || data(g('DT_ABERTURA')),
          objeto: g('DS_OBJETO').slice(0, 200), link: g('LINK_LICITACON_CIDADAO'), nome: g('NM_ORGAO'),
        });
      },
    },
    'item.csv': {
      filtro: anoRecente,
      linha: (c) => {
        if (!cabItem.length) { cabItem = c; return; }
        if (!(numero(c[cabItem.indexOf('VL_UNITARIO_HOMOLOGADO')])! > 0)) return;
        itens.push(c);
      },
    },
    'pessoas.csv': {
      linha: (c) => {
        if (!cabPes.length) { cabPes = c; return; }
        pessoas.set(txt(c[cabPes.indexOf('NR_DOCUMENTO')]), txt(c[cabPes.indexOf('NM_PESSOA')]));
      },
    },
  });
  if (!cabItem.length) throw new Error('O arquivo do TCE-RS veio sem a lista de itens (item.csv).');

  const col = (n: string) => cabItem.indexOf(n);
  const docs = cabItem.map((h, k) => (h === 'NR_DOCUMENTO' ? k : -1)).filter((k) => k >= 0);
  const linhas = itens.map((c) => {
    const nr = txt(c[col('NR_LICITACAO')]), ano = txt(c[col('ANO_LICITACAO')]), mod = txt(c[col('CD_TIPO_MODALIDADE')]);
    const lic = lics.get(`${nr}|${ano}|${mod}`);
    const quandoItem = lic?.data || data(c[col('DT_REF_VALOR_ESTIMADO')]);
    if (!quandoItem || quandoItem < desdeTxt) return null;
    const doc = docs.map((k) => txt(c[k])).find(Boolean) || '';
    const descricao = txt(c[col('DS_ITEM')]).replace(/\s+/g, ' ');
    if (!descricao) return null;
    return {
      cd_orgao: cd, orgao: lic?.nome || org.nome, municipio: org.municipio,
      licitacao: `${mod} ${nr}/${ano}`, modalidade: MODALIDADE[mod] || mod,
      nr_lote: txt(c[col('NR_LOTE')]), nr_item: txt(c[col('NR_ITEM')]),
      descricao: descricao.slice(0, 600), busca: semAcento(descricao),
      unidade: txt(c[col('SG_UNIDADE_MEDIDA')]), quantidade: numero(c[col('QT_ITENS')]),
      valor: numero(c[col('VL_UNITARIO_HOMOLOGADO')]), valor_estimado: numero(c[col('VL_UNITARIO_ESTIMADO')]),
      data: quandoItem, fornecedor: pessoas.get(doc) || doc, objeto: lic?.objeto || '', link: lic?.link || '',
    };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  const { error: e1 } = await adm.from('licitacon_orgaos').upsert({ cd_orgao: cd, nome: org.nome, municipio: org.municipio, itens: linhas.length, arquivo_de: quando, carregado_em: new Date().toISOString() });
  if (e1) throw new Error('Erro ao gravar o órgão: ' + e1.message + ' (o script licitacon.sql foi executado?)');
  const { error: e2 } = await adm.from('licitacon_itens').delete().eq('cd_orgao', cd);
  if (e2) throw new Error(e2.message);
  for (let i = 0; i < linhas.length; i += 1000) {
    const { error } = await adm.from('licitacon_itens').insert(linhas.slice(i, i + 1000));
    if (error) throw new Error('Erro ao gravar os itens: ' + error.message);
  }
  return { cd_orgao: cd, nome: org.nome, municipio: org.municipio, itens: linhas.length, arquivo_de: quando };
}

async function precosLicitacon(adm: ReturnType<typeof createClient>, texto: string, orgaos: number[], meses: number) {
  // palavras com números (100w, 12000) ficam de fora: cada licitação escreve de um jeito; o filtro da tela cuida delas.
  // compara pelo começo (7 letras), o que aguenta plural e erro de digitação no fim da palavra
  const todas = [...new Set(semAcento(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w)).map(raiz))];
  const palavras = [...new Set((todas.some((w) => !/\d/.test(w)) ? todas.filter((w) => !/\d/.test(w)) : todas).map((w) => (w.length > 7 ? w.slice(0, 7) : w)))];
  if (!palavras.length) throw new Error('Digite ao menos uma palavra com 3 letras.');
  const desde = new Date(); desde.setMonth(desde.getMonth() - meses);
  let q = adm.from('licitacon_itens').select('*').gte('data', desde.toISOString().slice(0, 10));
  if (orgaos.length) q = q.in('cd_orgao', orgaos);
  // cada palavra no começo de uma palavra da descrição ("cadeira" não pega "abraçadeira")
  for (const w of palavras) q = q.filter('busca', 'match', `(^|[^a-z0-9])${w}`);
  const { data: linhas, error } = await q.order('data', { ascending: false }).limit(1500);
  if (error) throw new Error(error.message + ' (o script licitacon.sql foi executado?)');
  return (linhas || []).map((x) => ({
    id_compra: x.licitacao, item: [x.nr_lote && x.nr_lote !== '1' ? 'lote ' + x.nr_lote : '', x.nr_item].filter(Boolean).join(' item '),
    catmat: '', descricao: x.descricao, valor: Number(x.valor), quantidade: x.quantidade == null ? null : Number(x.quantidade),
    unidade: x.unidade || '', data: x.data, orgao: x.orgao, uasg: x.modalidade ? `${x.modalidade} ${x.licitacao.split(' ')[1] || ''}` : '', codigo_uasg: '',
    municipio: x.municipio || '', uf: 'RS', esfera: '', fornecedor: x.fornecedor || '', marca: '', objeto: x.objeto || '',
    estimado: false, fonte: 'LicitaCon', link: x.link || '',
  }));
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
      // compara pelo começo das palavras (7 letras): "amplificadora" acha "amplificação" e aguenta erro de digitação no fim
      const pref = (w: string) => (w.length > 7 ? w.slice(0, 7) : w);
      // palavras de 2 letras (ex.: "ar" condicionado) só contam como palavra inteira no nome
      const curtas = semAcento(texto).split(/[^a-z0-9]+/).filter((w) => w.length === 2 && !PALAVRAS_VAZIAS.has(w));
      const palavras = [...new Set(semAcento(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w)).map(raiz).map(pref))];
      if (!palavras.length) return json({ erro: 'Digite ao menos uma palavra com 3 letras.' }, 400);
      // contexto = descrição completa do bem: as outras palavras dela ajudam a desempatar
      const ctx = [...new Set(semAcento(txt(b.contexto).slice(0, 600)).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !PALAVRAS_VAZIAS.has(w)).map(raiz).map(pref))]
        .filter((w) => !palavras.includes(w)).slice(0, 30);
      const { data: cand, error } = await adm.from('catmat_pdm').select('codigo,nome,classe,ativo,busca')
        .or(palavras.map((w) => `busca.ilike.*${w}*`).join(',')).limit(2000);
      if (error) throw new Error(error.message);
      const lista = (cand || []).map((x) => {
        const nome = semAcento(x.nome as string), busca = x.busca as string;
        const noNome = palavras.filter((w) => nome.includes(w)).length;
        const naClasse = palavras.filter((w) => busca.includes(w)).length;
        const extraNome = ctx.filter((w) => nome.includes(w)).length, extra = ctx.filter((w) => busca.includes(w)).length;
        const curta = curtas.filter((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(nome)).length;
        const comeca = nome.startsWith(curtas.length && texto.trim().toLowerCase().startsWith(curtas[0] + ' ') ? curtas[0] : palavras[0]) ? 1 : 0;
        return { ...x, pontos: (noNome + curta) * 10 + naClasse * 4 + extraNome * 3 + extra + comeca * 5 + (x.ativo ? 3 : 0) - (/ - /.test(nome) ? 3 : 0) - nome.length / 100 }; // "X - Y" costuma ser peça ou acessório
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

    // ---------- preços no PNCP, por texto ----------
    if (b.acao === 'pncp') {
      const texto = txt(b.texto).slice(0, 120);
      const ufs: string[] = Array.isArray(b.ufs) ? [...new Set((b.ufs as unknown[]).map((u) => txt(u).toUpperCase()).filter((u) => UFS.includes(u)))] : [];
      const meses = Math.min(60, Math.max(1, Number(b.meses) || 12));
      const r = await precosPncp(adm, texto, ufs, meses);
      return json({ itens: r.itens, encontrados: r.itens.length, compras_lidas: r.compras, compras_na_fonte: r.achadas, consultado_em: new Date().toISOString() });
    }

    // ---------- LicitaCon (TCE-RS) ----------
    if (b.acao === 'lc_orgaos') {
      const { data: l, error } = await adm.from('licitacon_orgaos').select('*').order('nome');
      if (error) return json({ erro: 'Rode antes o script licitacon.sql no Supabase. (' + error.message + ')' }, 500);
      return json({ orgaos: l || [] });
    }
    if (b.acao === 'lc_procurar') {
      const t = semAcento(txt(b.texto)).trim();
      if (t.length < 3) return json({ erro: 'Digite ao menos 3 letras do município ou do órgão.' }, 400);
      const lista = (await listaOrgaosTce(adm)).filter((o) => o.ativo && (semAcento(o.municipio).includes(t) || semAcento(o.nome).includes(t)));
      const ordem = (o: { nome: string; tipo: string }) => (/^PM /.test(o.nome) ? 0 : o.tipo === 'EXECUTIVO' ? 1 : 2);
      return json({ orgaos: lista.sort((a, c) => ordem(a) - ordem(c) || a.nome.localeCompare(c.nome)).slice(0, 40) });
    }
    if (b.acao === 'lc_carregar') {
      const cd = Number(b.cd_orgao);
      if (!Number.isInteger(cd) || cd <= 0) return json({ erro: 'Órgão inválido.' }, 400);
      return json(await carregarOrgaoLc(adm, cd));
    }
    if (b.acao === 'lc_remover') {
      const cd = Number(b.cd_orgao);
      const { error } = await adm.from('licitacon_orgaos').delete().eq('cd_orgao', cd);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (b.acao === 'licitacon') {
      const texto = txt(b.texto).slice(0, 120);
      const orgaos: number[] = Array.isArray(b.orgaos) ? (b.orgaos as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      const meses = Math.min(36, Math.max(1, Number(b.meses) || 12));
      const itens = await precosLicitacon(adm, texto, orgaos, meses);
      return json({ itens, encontrados: itens.length, consultado_em: new Date().toISOString() });
    }

    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});

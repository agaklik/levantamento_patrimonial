# Levantamento Patrimonial

Aplicativo de campo para o levantamento (inventário físico) de bens patrimoniais de órgãos públicos. A equipe percorre os locais com o celular, lê a placa de cada bem, confere localização, estado de conservação e situação, registra fotos e, ao final, o administrador exporta um arquivo pronto para atualizar o sistema de patrimônio.

Versão atual: `v2026.11.11-27` (aparece na tela de login).

## Sumário

- [O que o app faz](#o-que-o-app-faz)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Perfis de acesso](#perfis-de-acesso)
- [Uso em campo](#uso-em-campo)
- [Uso pelo administrador](#uso-pelo-administrador)
- [Página de administração: reavaliação e documentos](#página-de-administração-reavaliação-e-documentos)
- [Arquivos CSV de importação](#arquivos-csv-de-importação)
- [Arquivo de exportação ATUALIZA.csv](#arquivo-de-exportação-atualizacsv)
- [Regras de negócio](#regras-de-negócio)
- [Instalação e configuração](#instalação-e-configuração)
- [Banco de dados](#banco-de-dados)
- [Segurança](#segurança)
- [Publicar uma nova versão](#publicar-uma-nova-versão)
- [Limitações conhecidas](#limitações-conhecidas)
- [Estrutura do repositório](#estrutura-do-repositório)

## O que o app faz

- **Login** por e-mail e senha.
- **Localiza o bem** lendo o código de barras da placa pela câmera, ou digitando a placa ou o código do item.
- **Mostra a ficha do bem**: placa, código, descrição, classificação, marca, modelo e valor atual.
- **Registra o levantamento**: localização encontrada, estado de conservação, situação, motivo da movimentação, comissão de avaliação e fotos.
- **Trata bens sem placa**: permite informar ou escanear a placa encontrada em campo, com checagem de duplicidade.
- **Acompanha o progresso**: barra com o percentual de bens já levantados.
- **Importa os dados de base** (bens, localizações e motivos) por CSV.
- **Lista e exporta** os bens encontrados e os não encontrados.
- **Gera o `ATUALIZA.csv`**, no layout de importação do sistema de patrimônio.
- **Instala como aplicativo** no celular (PWA), com ícone na tela inicial.

## Como funciona por dentro

| Parte | Tecnologia |
| --- | --- |
| Interface | Um único arquivo `index.html`, com HTML, CSS e JavaScript puro |
| Banco de dados, login e fotos | [Supabase](https://supabase.com) (PostgreSQL, Auth e Storage) |
| Leitura de código de barras | ZXing (embutido no `index.html`) |
| Leitura de CSV | PapaParse (embutido no `index.html`) |
| Instalação como app | `manifest.json` e `sw.js` (service worker) |

Não há etapa de build nem dependências para instalar. As bibliotecas estão embutidas no próprio `index.html`, e o app é servido como site estático.

O service worker guarda em cache a "casca" do app (a tela). O envio dos dados segue o parâmetro **Envio dos dados do app de campo**, definido pelo administrador:

- **Online:** cada item salvo vai direto para a nuvem. Se a internet cair no meio do trabalho, o item fica guardado no celular e é enviado sozinho quando a conexão voltar.
- **Offline (exportação):** o app baixa a base para o celular e guarda os registros localmente. Pelo botão de nuvem no topo, a equipe envia tudo quando tiver internet ou exporta um arquivo `.json`, que o administrador recebe na aba **Configuração** do painel.

## Perfis de acesso

| Perfil | O que pode fazer |
| --- | --- |
| **Equipe de campo** (usuário logado) | Buscar bens pela placa, pela câmera ou pelo nome, registrar o levantamento, tirar fotos, informar placa de bem sem placa e enviar ou exportar o que fez |
| **Administrador** | Tudo o que a equipe faz, mais a página de administração (`admin.html`): importar CSVs, cadastrar usuários e a comissão, definir o modo de envio, receber arquivos do campo, baixar listas, gerar o `ATUALIZA.csv`, reavaliar e emitir documentos |

Quem é administrador é definido no banco, pela tabela `admins` e pela função `is_admin()`, criadas pelo script [`supabase/seguranca.sql`](supabase/seguranca.sql). As regras de acesso do mesmo script é que de fato impedem um usuário comum de importar ou excluir dados; esconder a engrenagem é só a parte visual.

Enquanto o script não for executado, a página de administração mostra um aviso pedindo para executá-lo.

## Uso em campo

1. Abra o app e entre com e-mail e senha.
2. Toque em **📷 Ler código de barras** e aponte para a placa. Se a etiqueta estiver ilegível, digite a placa, ou troque para **Por código** e digite o código do item.
3. Confira a ficha do bem.
4. Ajuste o que for diferente do cadastro:
   - **Localização:** toque no ✕ e digite parte do nome ou do código para buscar.
   - **Estado de conservação** e **Situação.**
   - **Motivo da movimentação:** já vem preenchido com o motivo padrão do levantamento.
5. Toque em **📸 Tirar foto** quantas vezes precisar. As fotos são enviadas ao salvar.
6. Marque **Levantamento deste item concluído**.
7. Toque em **💾 Salvar item**. O app volta para a busca, pronto para o próximo bem.

**Bem sem placa:** abra o item pelo código. A ficha mostra um campo para digitar ou escanear a placa encontrada. O app avisa se a placa já pertence a outro bem e, ao salvar, grava a placa no cadastro. Deixe em branco se o bem realmente não tiver placa.

**Instalar no celular:** no Chrome (Android), menu ⋮ e "Adicionar à tela inicial". No Safari (iPhone), botão de compartilhar e "Adicionar à Tela de Início".

## Uso pelo administrador

Toda a configuração é feita na página de administração (endereço do app seguido de `/admin.html`), na aba **Configuração**. O app de campo não tem configurações: serve só para o levantamento.

### Preparar um levantamento

1. Em **Configuração**, **Importar localizações**, **Importar motivos** e **Importar bens**, nessa ordem.
2. Cadastrar a **Comissão de avaliação** (código e descrição), na mesma aba.
3. Cadastrar a equipe na aba **Usuários**: nome completo (nome e sobrenome), nome de usuário opcional, e-mail válido, senha inicial e perfil (campo ou administrador). A senha precisa ter 10 ou mais caracteres, com maiúscula, minúscula, número e símbolo, sem conter o e-mail nem o nome de usuário; o botão **gerar** cria uma senha assim. Na mesma aba é possível editar nome e usuário, trocar o perfil, bloquear, reativar e definir nova senha.

No app de campo e no painel, a pessoa entra com o e-mail ou com o nome de usuário. **Esqueci minha senha** envia um link para o e-mail cadastrado criar uma nova senha.
4. Escolher, em **Configuração**, se o app de campo envia os dados **online** ou por **exportação de arquivo**.

### Importação

A importação **inclui ou atualiza** os registros do arquivo pela chave (código do bem, código da localização ou código do motivo). Ela nunca apaga o levantamento já feito.

- Se a base tiver registros que não vieram no arquivo, o app pergunta se deve removê-los.
- Um bem que já tem levantamento nunca é removido, mesmo que não esteja no arquivo.
- A placa informada em campo é preservada quando o arquivo traz a placa em branco.
- Linhas com a mesma chave no arquivo são ignoradas a partir da segunda ocorrência.

### Comissão de Avaliação

O levantamento usa uma única comissão. Ao salvar uma nova, ela substitui a anterior e é aplicada a todos os itens já levantados. O código informado vai para o `ATUALIZA.csv`.

### Acompanhamento

- Na aba **Reavaliação**, o filtro de situação mostra os bens encontrados ou não localizados.
- Na aba **Documentos**, **Listas do levantamento** baixa a lista completa de encontrados ou não encontrados (CSV com código, placa, descrição e localização).

### Exportação

Na aba **Documentos**, **Arquivo para o sistema de patrimônio** gera o `ATUALIZA.csv` com todos os itens levantados. Antes de gerar, o painel confere se há placas repetidas e pede confirmação.

No modo offline, os arquivos `.json` exportados pelo app de campo são recebidos em **Configuração**, **Receber arquivo do app de campo**. Um registro mais antigo que o já gravado na nuvem é ignorado.

## Página de administração: reavaliação e documentos

O app de campo cuida do levantamento. Depois que ele termina, o trabalho continua em **`admin.html`**, uma página pensada para o computador e restrita a administradores. O acesso é pelo endereço do app seguido de `/admin.html`.

Antes do primeiro uso, execute [`supabase/reavaliacao.sql`](supabase/reavaliacao.sql) no SQL Editor do Supabase (depois do `seguranca.sql`).

### Abas

| Aba | Para que serve |
| --- | --- |
| **Painel** | Totais de bens, encontrados, não localizados e reavaliados; valor contábil, valor reavaliado e variação; resumo por classificação |
| **Reavaliação** | Lista dos bens com filtros. Clicar em um bem abre a ficha com os dados do levantamento, as fotos e o formulário de reavaliação |
| **Documentos** | Geração dos laudos, termos e relatórios |
| **Configuração** | Dados do órgão, comissão, responsável técnico e parâmetros do cálculo |

### Métodos de reavaliação

| Método | Como o valor é obtido |
| --- | --- |
| **Valor de bem novo × fator de reavaliação** | Valor de referência (preço de um bem novo equivalente) multiplicado pelo fator |
| **Valor de mercado de bem equivalente** | Valor informado diretamente |
| **Valor definido em laudo técnico** | Valor informado diretamente |

O fator de reavaliação é calculado por:

```
Fator = (4 × EC + 6 × PVU − 3 × PUB) ÷ 100
```

- **EC**, estado de conservação: Excelente 10, Bom 8, Regular 5, Péssimo 2. Vem do estado registrado no levantamento.
- **PVU**, vida útil futura estimada, de 0 a 10 anos.
- **PUB**, tempo de uso do bem, de 0 a 10 anos. Vem sugerido pela data de ingresso e pela data-base.
- Quando o resultado fica abaixo do **fator mínimo** (padrão 0,10), vale o mínimo.

PVU e PUB chegam preenchidos com uma sugestão e podem ser alterados pelo avaliador. Pesos, notas, fator mínimo e percentual de valor residual são ajustáveis na aba Configuração. **Confira esses parâmetros com a norma adotada pelo órgão antes de emitir os laudos.**

### Conclusão das localizações e valor por tipo de bem

A reavaliação segue a ordem do levantamento:

1. Ao terminar uma sala ou setor, a equipe toca em **Concluir uma localização** no app de campo. O banco registra quem concluiu, a data e a hora. A conclusão precisa de internet.
2. A aba **Painel** traz a lista **Conclusão das localizações**, com bens, levantados, quem concluiu e quando. O administrador pode concluir por ali ou **reabrir** uma localização.
3. Na aba **Reavaliação**, só os bens de localizações concluídas ficam liberados (filtro "Liberados, a reavaliar").
4. Cada descrição de bem tem **um único valor de referência**, guardado na tabela `referencias`. Ao salvar o valor de um bem, o painel oferece aplicar o mesmo valor aos outros bens liberados com a mesma descrição; o fator de cada um vem do estado e do tempo de uso dele. Quando outra localização é concluída depois, o botão **Valores por tipo de bem** aplica os valores já definidos aos novos bens, sem nova pesquisa.
5. Alterar o valor de referência de um tipo exige confirmação e recalcula todos os bens daquele tipo já reavaliados, para que bens iguais nunca fiquem com referências diferentes.

**Localização de origem.** Quando, antes da importação, todos os bens são transferidos no sistema para uma única localização (ex.: "Levantamento 2026"), o painel e o app a reconhecem sozinhos: é a localização que concentra mais da metade dos bens do cadastro importado. Ela fica fora da conclusão das localizações: cada bem encontrado sai dela para a sala onde está, as salas mostram só os bens encontrados, e o que sobrar nela ao final é tratado como não localizado.

Instalação: rodar [`supabase/conclusao.sql`](supabase/conclusao.sql) no SQL Editor. Sem ele, o painel funciona como antes (todos os bens encontrados liberados).

### Pesquisa de preços de referência

Na ficha do bem, ao lado do valor de referência, o botão **Pesquisar preços** consulta os preços pagos em compras públicas, na base de dados abertos do Compras.gov.br (módulo Pesquisa de Preço):

1. Digite o nome do bem (ex.: cadeira escritório) e escolha o **tipo de material** do catálogo do governo (PDM do CATMAT), ou digite o código CATMAT do item. Na primeira busca o painel copia a lista de tipos de material para o Supabase (a API do governo não tem busca por palavra); leva cerca de um minuto.
2. Escolha a abrangência: **estado** (padrão: o estado do órgão, tirado de "Município / UF" na Configuração), **região** (Sul, Sudeste, Centro-Oeste, Nordeste, Norte) ou **Brasil inteiro**; e o período (6, 12 ou 24 meses; padrão 12).
3. Use **Filtrar pela descrição** para ficar só com bens iguais ao avaliado (ex.: giratória, espaldar médio), desmarque os preços que não servem (outro modelo, valor fora da realidade) e clique em **Usar mediana**, **Usar média** ou **Usar menor**.

O valor vai para o campo de referência, a fonte é preenchida sozinha e os preços marcados ficam guardados com a reavaliação e aparecem no laudo. As consultas ficam em cache por 24 horas. Próximas fontes previstas: PNCP e LicitaCon (TCE-RS).

### Reavaliar em lote

**Pela tela:** na aba Reavaliação, marque os bens na lista e clique em **Reavaliar selecionados**. Informe o valor de referência de cada bem (ou um mesmo valor para todos) e a fonte; o painel calcula o fator de cada um e grava tudo de uma vez. Bens com a mesma descrição recebem sempre o mesmo valor.

**Pela planilha:**

1. Na aba Reavaliação, filtre os bens e clique em **Planilha de pesquisa de preços**. O arquivo traz código, placa, descrição, marca, modelo, estado e valor atual.
2. Preencha as colunas `valor_referencia` e `fonte`.
3. Clique em **Importar valores de referência**. Cada bem com valor preenchido é reavaliado pelo método do fator, com os parâmetros sugeridos. Depois é possível abrir qualquer bem e ajustar.

### Documentos gerados

| Documento | Conteúdo |
| --- | --- |
| **Laudo de avaliação por item** | Um por bem: identificação, vistoria (com fotos), metodologia, resultado e assinaturas |
| **Termo de responsabilidade** | Um por localização, com os bens encontrados e espaço para assinatura do responsável |
| **Relatório de bens não localizados** | Bens sem levantamento concluído, por localização de origem |
| **Relatório geral da reavaliação** | Todos os bens reavaliados, com totais por classificação. Também disponível em CSV |

Os documentos abrem em uma pré-visualização. O botão **Imprimir / salvar em PDF** usa a impressão do navegador. As assinaturas seguem a modalidade escolhida na Configuração: comissão de servidores, responsável técnico ou ambos.

## Arquivos CSV de importação

O separador (vírgula ou ponto e vírgula) é detectado automaticamente. A primeira linha deve conter os cabeçalhos. São aceitos tanto os nomes das colunas do banco quanto os cabeçalhos do relatório do sistema de patrimônio.

### Bens

`Código` é obrigatório e é a chave. `Placa` é opcional. Zeros à esquerda de código e placa são removidos.

| Coluna no banco | Cabeçalhos aceitos |
| --- | --- |
| `placa` | `placa`, `Placa` |
| `codigo` | `codigo`, `Código`, `Codigo` |
| `descricao` | `descricao`, `Descrição Completa`, `Descricao Completa` |
| `descricao_reduzida` | `descricao_reduzida`, `Descrição Reduzida`, `Descricao Reduzida` |
| `marca` | `marca`, `MARCA` |
| `modelo` | `modelo`, `MODELO` |
| `cod_localizacao` | `cod_localizacao`, `Cód Localização`, `Cod Localizacao` |
| `localizacao` | `localizacao`, `Localização`, `Localizacao` |
| `cod_classificacao` | `cod_classificacao`, `Cód. Classificação`, `Cod. Classificacao` |
| `classificacao` | `classificacao`, `Classificação`, `Classificacao` |
| `cod_situacao` | `cod_situacao`, `Cód. Situação`, `Cod. Situacao` |
| `situacao` | `situacao`, `Situação`, `Situacao` |
| `cod_estado` | `cod_estado`, `Cód. EstadoConservação`, `Cod. EstadoConservacao` |
| `estado` | `estado`, `Estado de Conservação`, `Estado de Conservacao` |
| `data_ingresso` | `data_ingresso`, `Data do Ingresso` |
| `tipo_ingresso` | `tipo_ingresso`, `Tipo de Ingresso` |
| `cod_fornecedor` | `cod_fornecedor`, `Cód. Fornecedor`, `Cod. Fornecedor` |
| `cod_convenio` | `cod_convenio`, `Cód. Convenio`, `Cod. Convenio` |
| `valor_atual` | `valor_atual`, `Valor Atual` |
| `contabil` | `contabil`, `Contábil`, `Contabil` |
| `depreciavel` | `depreciavel`, `Depreciável`, `Depreciavel` |
| `metodo_depreciacao` | `metodo_depreciacao`, `Método de Depreciação`, `Metodo de Depreciacao` |
| `vida_util` | `vida_util`, `Vida Útil`, `Vida Util` |
| `valor_residual` | `valor_residual`, `Valor Residual` |
| `data_inicio_depreciacao` | `data_inicio_depreciacao`, `Data Inicio Depreciação`, `Data Inicio Depreciacao` |

### Localizações

| Coluna no banco | Cabeçalhos aceitos | Observação |
| --- | --- | --- |
| `cod` | `cod`, `cdLocalReduzido` | Obrigatório, chave |
| `desc_` | `desc_`, `dsLocalizacao` | Descrição |
| `unidade_gestora` | `unidade_gestora`, `cdUnidadeGestora` | Opcional |

### Motivos

| Coluna no banco | Cabeçalhos aceitos | Observação |
| --- | --- | --- |
| `cod` | `cod`, `cdMotivo` | Obrigatório, chave |
| `desc_` | `desc_`, `dsMotivo` | Descrição |

## Arquivo de exportação ATUALIZA.csv

Codificação UTF-8 com BOM, separador vírgula, quebra de linha CRLF. Uma linha por item levantado, com as colunas nesta ordem:

| # | Coluna | Origem |
| --- | --- | --- |
| 1 | Data do Movimento | Data da movimentação se a localização mudou; senão, a data de hoje |
| 2 | Placa | Placa do bem, ou a placa informada em campo |
| 3 | Descrição | Cadastro do bem |
| 4 | Descrição Reduzida | Cadastro do bem |
| 5 | Marca | Cadastro do bem |
| 6 | Modelo | Cadastro do bem |
| 7 | Código Localização | Levantamento, ou cadastro se não foi alterada |
| 8 | Código Classificação | Cadastro do bem |
| 9 | Código Situação | Levantamento, ou cadastro |
| 10 | Código Estado Conservação | Levantamento, ou cadastro |
| 11 | Data da Aquisição | Cadastro do bem (data de ingresso) |
| 12 | Código Tipo Ingresso | Cadastro do bem |
| 13 | Código Fornecedor | Cadastro do bem |
| 14 | Código Convênio | Cadastro do bem |
| 15 | Valor Atual | Cadastro do bem |
| 16 | inContabil | Cadastro do bem |
| 17 | inDepreciavel | Cadastro do bem |
| 18 | Código Método Depreciação | Cadastro do bem |
| 19 | Vida Útil | Cadastro do bem |
| 20 | Valor Residual | Cadastro do bem |
| 21 | Data Início Depreciação | Cadastro do bem |
| 22 | Código Motivo Movimentação | Levantamento, ou o motivo padrão |
| 23 | Código Comissão Avaliação | Comissão cadastrada |

Datas saem como `dd/mm/aaaa` e valores com vírgula decimal.

## Regras de negócio

- **Unidade gestora:** um bem não pode ser movido para uma localização de outra unidade gestora. A busca de localização só mostra as da mesma unidade do bem.
- **Motivo:** se a localização mudou, o motivo da movimentação é obrigatório.
- **Comissão:** não é possível salvar um item sem uma comissão cadastrada.
- **Placa nova:** não pode repetir a placa de outro bem nem uma placa já informada em outro levantamento.
- **Encontrado:** um bem conta como encontrado quando o levantamento está marcado como concluído.
- **Leitura de etiqueta:** o que a câmera lê é sempre buscado como placa.

## Instalação e configuração

### 1. Projeto no Supabase

Crie um projeto no Supabase com as tabelas descritas em [Banco de dados](#banco-de-dados) e um bucket de Storage chamado `fotos`.

### 2. Apontar o app para o projeto

No início do bloco de script do `index.html` ficam os parâmetros:

| Constante | Significado |
| --- | --- |
| `SUPABASE_URL` | Endereço do projeto Supabase |
| `SUPABASE_KEY` | Chave pública (publishable/anon) do projeto |
| `FOTOS_BUCKET` | Nome do bucket das fotos (`fotos`) |
| `MOTIVO_PADRAO` | Código do motivo de movimentação padrão do levantamento |
| `APP_VERSION` | Versão exibida na tela de login |
| `ESTADOS_FIXOS` | Estados de conservação: 1 Excelente, 2 Bom, 3 Regular, 4 Péssimo |
| `SITUACOES_FIXAS` | Situações: 1 Em uso, 2 Em estoque, 3 Cedido, 4 Depósito (inservível) |
| `UNIDADES_GESTORAS` | Código e nome das unidades gestoras |

Use somente a chave pública. A chave `service_role` nunca deve aparecer no código.

### 3. Regras de acesso

No painel do Supabase, abra o SQL Editor, cole o conteúdo de [`supabase/seguranca.sql`](supabase/seguranca.sql), troque `SEU_EMAIL_AQUI` pelo e-mail de login do administrador e execute. O script pode ser executado mais de uma vez.

Em seguida, execute da mesma forma o [`supabase/reavaliacao.sql`](supabase/reavaliacao.sql), que cria as tabelas da página de administração.

Para incluir outro administrador depois:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'email-do-novo-administrador'
on conflict do nothing;
```

### 4. Usuários

O cadastro de usuários pela aba **Usuários** precisa de duas peças no Supabase:

1. Rodar [`supabase/usuarios.sql`](supabase/usuarios.sql) no SQL Editor (depois do `seguranca.sql`).
2. Publicar a função [`supabase/functions/usuarios`](supabase/functions/usuarios/index.ts) em Edge Functions (nome `usuarios`). Ela usa a chave de serviço do próprio Supabase, que nunca vai para o navegador, e só atende administradores.

Sem essas peças, os usuários continuam podendo ser criados em Authentication, Users, no painel do Supabase.

Ajustes no painel do Supabase para o login por nome de usuário e a recuperação de senha:

- Em Edge Functions, `usuarios`, **desligar "Verify JWT"** (Enforce JWT Verification). A função confere a sessão por conta própria e só atende administradores, exceto nas ações de entrar e recuperar senha.
- Em Authentication, URL Configuration, cadastrar o endereço do app em **Redirect URLs** (ex.: `https://agaklik.github.io/levantamento_patrimonial/**`).
- Em Authentication, configurar um **SMTP próprio** (Gmail, Resend etc.). O envio padrão do Supabase só entrega e-mails para membros da equipe do projeto e tem limite baixo por hora.
- Opcional: em Authentication, exigir senha mínima de 10 caracteres com letras, números e símbolos, para a regra valer também no servidor.

Para a **pesquisa de preços** na reavaliação:

1. Rodar [`supabase/precos.sql`](supabase/precos.sql) no SQL Editor (depois do `reavaliacao.sql`).
2. Publicar a função [`supabase/functions/precos`](supabase/functions/precos/index.ts) em Edge Functions (nome `precos`) e **desligar "Verify JWT"**. Ela confere a sessão e só atende administradores.

### 5. Hospedagem

Publique os arquivos da raiz do repositório em qualquer hospedagem de site estático com HTTPS (por exemplo, GitHub Pages). O HTTPS é obrigatório para a câmera e para a instalação como app.

## Banco de dados

| Tabela | Chave | Conteúdo |
| --- | --- | --- |
| `bens` | `codigo` | Cadastro dos bens, importado do sistema de patrimônio (colunas na seção de CSV) |
| `levantamento` | `codigo` | Um registro por bem levantado |
| `localizacoes` | `cod` | `cod`, `desc_`, `unidade_gestora` |
| `motivos` | `cod` | `cod`, `desc_` |
| `comissoes` | `cod` | `cod`, `desc_` |
| `admins` | `user_id` | Usuários administradores (criada pelo script de segurança) |
| `reavaliacao` | `codigo` | Uma reavaliação por bem: método, parâmetros, valor reavaliado, nova vida útil, valor residual e fonte |
| `configuracao` | `id` | Linha única com os dados do órgão, a comissão e os parâmetros do cálculo |

Colunas de `levantamento`: `codigo`, `placa_nova`, `cod_localizacao`, `localizacao`, `cod_situacao`, `situacao`, `cod_estado`, `estado`, `cod_motivo`, `cod_comissao`, `data_movimento`, `concluido`, `atualizado_em`.

As fotos ficam no bucket `fotos`, em uma pasta por bem: `<código do bem>/<data e hora>_<sufixo>.jpg`.

## Segurança

O script [`supabase/seguranca.sql`](supabase/seguranca.sql) configura:

- **RLS ligado** nas tabelas. Sem login, ninguém lê nem grava.
- **Equipe de campo:** lê todas as tabelas, inclui e altera levantamentos e atualiza o cadastro do bem (para gravar a placa encontrada).
- **Somente administrador:** incluir e excluir bens, alterar localizações, motivos e comissões, excluir levantamentos e excluir fotos.
- **Bucket `fotos` privado:** o app abre as fotos por link assinado, válido por uma hora.

Ao ser executado, o script remove as políticas de acesso que já existiam nessas tabelas e no bucket `fotos` antes de criar as novas.

A chave que aparece no `index.html` é pública por natureza. O que protege os dados são as regras acima, por isso o script precisa estar aplicado em qualquer projeto que use este app.

## Publicar uma nova versão

1. Altere o `index.html`.
2. Atualize `APP_VERSION` para que a equipe consiga conferir, na tela de login, se está com a versão nova.
3. Envie para o branch `main`.

O service worker busca sempre a versão da rede quando há conexão. Se um aparelho continuar mostrando a versão antiga, feche e abra o app novamente.

## Limitações conhecidas

- **Modo offline:** as fotos tiradas sem internet ficam no celular até o envio; evite limpar os dados do navegador antes de enviar ou exportar.
- **Sem registro de autoria:** o levantamento guarda a data da última alteração, mas não quem a fez, e não mantém histórico.
- **Bem sem cadastro:** não há fluxo para registrar um bem encontrado em campo que não está na base.
- **Não localizado:** é deduzido pela ausência de levantamento concluído; não há marcação explícita nem campo de observações.
- **Exportação:** o `ATUALIZA.csv` inclui todos os itens salvos, mesmo os não marcados como concluídos.
- **Um cliente por projeto:** os parâmetros do órgão ficam fixos no código, e cada cliente precisa de um projeto Supabase próprio.
- **Comissão única** por levantamento.

## Estrutura do repositório

```
index.html              App de campo (interface, lógica e bibliotecas embutidas)
admin.html              Página de administração (reavaliação e documentos)
vendor/supabase.js      Biblioteca do Supabase usada pela página de administração
manifest.json           Dados para instalação como app (nome, cores, ícones)
sw.js                   Service worker (cache da casca do app)
icon-192.png            Ícone do app
icon-512.png            Ícone do app
supabase/seguranca.sql  Regras de acesso, perfil de administrador e bucket privado
supabase/reavaliacao.sql  Tabelas da reavaliação e da configuração
supabase/usuarios.sql   Tabela de perfil e situação dos usuários
supabase/functions/usuarios/  Função que cadastra e controla usuários
README.md               Este documento
```

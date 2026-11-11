# Levantamento Patrimonial

Aplicativo de campo para o levantamento (inventário físico) de bens patrimoniais de órgãos públicos. A equipe percorre os locais com o celular, lê a placa de cada bem, confere localização, estado de conservação e situação, registra fotos e, ao final, o administrador exporta um arquivo pronto para atualizar o sistema de patrimônio.

Versão atual: `v2026.11.11-26` (aparece na tela de login).

## Sumário

- [O que o app faz](#o-que-o-app-faz)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Perfis de acesso](#perfis-de-acesso)
- [Uso em campo](#uso-em-campo)
- [Uso pelo administrador](#uso-pelo-administrador)
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

O service worker guarda em cache apenas a "casca" do app (a tela). Todas as consultas e gravações vão direto ao Supabase, então **o uso exige internet**.

## Perfis de acesso

| Perfil | O que pode fazer |
| --- | --- |
| **Equipe de campo** (usuário logado) | Buscar bens, registrar o levantamento, tirar fotos, informar placa de bem sem placa e exportar o `ATUALIZA.csv` |
| **Administrador** | Tudo o que a equipe faz, mais a engrenagem ⚙️: importar CSVs, cadastrar a comissão e ver ou baixar as listas de encontrados e não encontrados |

Quem é administrador é definido no banco, pela tabela `admins` e pela função `is_admin()`, criadas pelo script [`supabase/seguranca.sql`](supabase/seguranca.sql). As regras de acesso do mesmo script é que de fato impedem um usuário comum de importar ou excluir dados; esconder a engrenagem é só a parte visual.

Enquanto o script não for executado, o app mantém o comportamento antigo (engrenagem liberada para todos) e mostra um aviso dentro dela.

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

A engrenagem ⚙️ no canto superior esquerdo abre **Tabelas e dados**.

### Preparar um levantamento

1. **Importar Localizações**, **Importar Motivos** e **Importar Bens**, nessa ordem.
2. Cadastrar a **Comissão de Avaliação** (código e descrição).
3. Criar os usuários da equipe no painel do Supabase, em Authentication, Users.

### Importação

A importação **inclui ou atualiza** os registros do arquivo pela chave (código do bem, código da localização ou código do motivo). Ela nunca apaga o levantamento já feito.

- Se a base tiver registros que não vieram no arquivo, o app pergunta se deve removê-los.
- Um bem que já tem levantamento nunca é removido, mesmo que não esteja no arquivo.
- A placa informada em campo é preservada quando o arquivo traz a placa em branco.
- Linhas com a mesma chave no arquivo são ignoradas a partir da segunda ocorrência.

### Comissão de Avaliação

O levantamento usa uma única comissão. Ao salvar uma nova, ela substitui a anterior e é aplicada a todos os itens já levantados. O código informado vai para o `ATUALIZA.csv`.

### Acompanhamento

- **Ver não encontrados** e **Ver encontrados** listam os bens (até 200 na tela). Toque em um item para abri-lo. Itens já encontrados abrem em modo de visualização.
- **Baixar (CSV)** gera a lista completa, com código, placa, descrição e localização.

### Exportação

O botão ⬇ no topo gera o `ATUALIZA.csv` com todos os itens levantados. Antes de gerar, o app confere se há placas repetidas e pede confirmação.

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

Para incluir outro administrador depois:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'email-do-novo-administrador'
on conflict do nothing;
```

### 4. Usuários

Crie os usuários da equipe em Authentication, Users, no painel do Supabase. O app não tem tela de cadastro.

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

- **Sem modo offline:** buscar e salvar exigem internet.
- **Sem registro de autoria:** o levantamento guarda a data da última alteração, mas não quem a fez, e não mantém histórico.
- **Bem sem cadastro:** não há fluxo para registrar um bem encontrado em campo que não está na base.
- **Não localizado:** é deduzido pela ausência de levantamento concluído; não há marcação explícita nem campo de observações.
- **Exportação:** o `ATUALIZA.csv` inclui todos os itens salvos, mesmo os não marcados como concluídos.
- **Um cliente por projeto:** os parâmetros do órgão ficam fixos no código, e cada cliente precisa de um projeto Supabase próprio.
- **Comissão única** por levantamento.

## Estrutura do repositório

```
index.html              Aplicativo completo (interface, lógica e bibliotecas embutidas)
manifest.json           Dados para instalação como app (nome, cores, ícones)
sw.js                   Service worker (cache da casca do app)
icon-192.png            Ícone do app
icon-512.png            Ícone do app
supabase/seguranca.sql  Regras de acesso, perfil de administrador e bucket privado
README.md               Este documento
```

# Connext Intelligence Platform

Plataforma de ingestão, unificação, enriquecimento e qualificação de leads B2B e B2C.

Produção: https://plataforma.connextintelligence.com (protegida por Cloudflare Access)

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `public/index.html` | Moldura, design system (modo claro e escuro) |
| `public/engine.js` | Motor de dados: ingestão, qualidade, identidade, golden record, scoring, enriquecimento, governança |
| `public/app.js` | Interface com as 18 áreas da plataforma |
| `public/sync.js` | Persistência: carrega o tenant do banco e envia só o que mudou |
| `src/index.js` | API do Worker: valida o login do Cloudflare Access, tenants, membros, sincronização, arquivos RAW |
| `migrations/` | Esquema do banco D1 (modelo canônico completo, conectores, funil) |
| `src/ai.js` | Motor de IA: leitura de arquivos e conexões e classificação do funil pela API do Claude, com orçamento e custo por chamada |
| `src/connectors.js` | Conectores de leitura: Google Sheets, HubSpot, Salesforce, PostgreSQL, MySQL |
| `src/ingest.js` | Importação no servidor (conectores e webhook) com o mesmo motor da interface |
| `src/vault.js` | Cofre: credenciais das conexões cifradas com AES-GCM |
| `tests/selftest.js` | Os 18 cenários de teste obrigatórios |
| `wrangler.jsonc` | Configuração do Cloudflare Workers (static assets) |

## Publicação

A Cloudflare publica automaticamente a cada push na branch `main` (Workers Builds).
Manualmente: `npx wrangler deploy`.

O endereço `workers.dev` e as URLs de preview ficam desligados, para que o único acesso seja pelo domínio protegido pelo Access.

## Banco de dados e armazenamento

| Recurso | Nome | Uso |
|---|---|---|
| D1 | `connext-intelligence` | Tenants, membros, fontes, importações, registros, decisões de identidade, perfis mestres e versões, enriquecimento, segmentos, supressão, eliminações, auditoria, consumo da API |
| R2 | `connext-raw` | Arquivos originais de cada importação (camada RAW), em `tenant/importação/arquivo` |

Nova migração: crie `migrations/0002_*.sql` e rode `npx wrangler d1 migrations apply connext-intelligence --remote`.

### Identidade e permissões
- A API só aceita requisições com o JWT do Cloudflare Access, validado no servidor (assinatura, audiência, emissor e validade).
- `BOOTSTRAP_ADMINS` vira administrador da organização `connext` no primeiro acesso.
- E-mails de `AUTO_JOIN_DOMAINS` entram automaticamente como Leitor; o administrador promove em Administration.
- Papéis: Administrador, Analista de dados e Leitor, aplicados na interface e de novo na API.

### Teste local
```
npx wrangler d1 migrations apply connext-intelligence --local
npx wrangler dev --var DEV_USER:admin@teste.local --var BOOTSTRAP_ADMINS:admin@teste.local
```
`DEV_USER` só existe em desenvolvimento local e substitui o login do Access.

## Motor de IA e conexões (v0.3)

- **Leitura de fontes:** o Claude Sonnet 5.5 recebe nomes de coluna, estatísticas e amostras mascaradas (nunca a base inteira) e devolve tipo de base, mapeamento com confiança e motivo, colunas sensíveis, sinais de funil e problemas de qualidade. A pessoa confirma antes de importar.
- **Funil comercial:** regras resolvem status conhecidos (HubSpot, Salesforce e termos em português); o Claude Haiku 5.5 decide os casos com status desconhecido ou observações em texto livre, recebendo só sinais comerciais e um número no lugar do nome. Toda decisão grava etapa, motivo, confiança, modelo e assinatura dos sinais; muda de novo só quando o lead muda. Pessoas podem corrigir.
- **Conexões:** webhook em `https://ingest.connextintelligence.com/in/{organização}/{conector}` (chave Bearer), Google Sheets (conta de serviço), HubSpot (token de app privado, incremental), Salesforce (client credentials, incremental), PostgreSQL e MySQL (SELECT somente leitura, coluna incremental opcional). Sincronização agendada a cada 15 minutos (cron).
- **Orçamento:** limite mensal em US$ por organização; o servidor bloqueia chamadas acima dele. Consumo em `agent_executions`.

## Regras de entrada de arquivos (v0.4)

1. **Análise obrigatória pelo Claude:** todo arquivo enviado é analisado automaticamente antes de gravar. O Claude recomenda importar, importar com ressalvas, revisar antes ou não importar, faz até 4 perguntas e aponta qual fonte cadastrada parece ser a origem. A pessoa decide.
2. **Fonte obrigatória e tag de origem:** cada registro grava `origin` (fonte, importação, arquivo, canal, quem enviou, IP, quando) e aparece no Lead 360 em "Origem dos dados".
3. **Comprovante de origem:** antes de qualquer registro ser gravado, o servidor recebe o arquivo, guarda o original no R2, calcula o SHA-256 e registra IP, cidade, região, país, CEP e coordenadas aproximados, provedor (ASN), datacenter Cloudflare, navegador, usuário, data, hora (Brasília), carimbo ISO UTC e epoch, fonte, base legal, id da análise da IA e a decisão. Webhooks e conexões recebem comprovante equivalente.
4. **Bloqueio no servidor:** importações sem comprovante e análise da IA, e registros ligados a elas, são recusados na sincronização.

### Segredos do Worker (configurados no painel da Cloudflare)
| Nome | Conteúdo |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API do Claude |
| `VAULT_KEY` | Frase aleatória longa; cifra as credenciais das conexões. Não trocar depois de criar conexões. |

## Testes

```
npm test
```

## Estado atual (v0.1)

Executa no navegador: ingestão de CSV, TSV, XLS, XLSX, JSON, JSONL e XML; mapeamento inteligente; 12 regras de qualidade; resolução de identidade com revisão humana e decisões reversíveis; golden record com evidência por campo; cinco indicadores e DQI versionado; enriquecimento por derivações internas; governança com isolamento por tenant, RBAC, supressão, correção, eliminação e auditoria.

Os dados do tenant inicial são sintéticos e identificados como tal. O provedor B2B é um adaptador de demonstração.

Persistência real em D1 e R2 desde a v0.2. O motor ainda roda no navegador: o tenant inteiro é carregado ao entrar, o que atende bem até algumas centenas de milhares de registros. Acima disso, o próximo passo é levar resolução e pontuação para o servidor (Queues + Workers).

Ainda não existe: conectores além de arquivo, orquestração durável e agentes Claude no backend.

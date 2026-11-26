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
| `migrations/` | Esquema do banco D1 (modelo canônico completo) |
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

## Testes

```
npm test
```

## Estado atual (v0.1)

Executa no navegador: ingestão de CSV, TSV, XLS, XLSX, JSON, JSONL e XML; mapeamento inteligente; 12 regras de qualidade; resolução de identidade com revisão humana e decisões reversíveis; golden record com evidência por campo; cinco indicadores e DQI versionado; enriquecimento por derivações internas; governança com isolamento por tenant, RBAC, supressão, correção, eliminação e auditoria.

Os dados do tenant inicial são sintéticos e identificados como tal. O provedor B2B é um adaptador de demonstração.

Persistência real em D1 e R2 desde a v0.2. O motor ainda roda no navegador: o tenant inteiro é carregado ao entrar, o que atende bem até algumas centenas de milhares de registros. Acima disso, o próximo passo é levar resolução e pontuação para o servidor (Queues + Workers).

Ainda não existe: conectores além de arquivo, orquestração durável e agentes Claude no backend.

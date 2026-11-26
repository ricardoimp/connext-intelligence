# Connext Intelligence Platform

Plataforma de ingestão, unificação, enriquecimento e qualificação de leads B2B e B2C.

Produção: https://plataforma.connextintelligence.com (protegida por Cloudflare Access)

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `public/index.html` | Moldura, design system (modo claro e escuro) |
| `public/engine.js` | Motor de dados: ingestão, qualidade, identidade, golden record, scoring, enriquecimento, governança |
| `public/app.js` | Interface com as 18 áreas da plataforma |
| `tests/selftest.js` | Os 18 cenários de teste obrigatórios |
| `wrangler.jsonc` | Configuração do Cloudflare Workers (static assets) |

## Publicação

A Cloudflare publica automaticamente a cada push na branch `main` (Workers Builds).
Manualmente: `npx wrangler deploy`.

O endereço `workers.dev` e as URLs de preview ficam desligados, para que o único acesso seja pelo domínio protegido pelo Access.

## Testes

```
npm test
```

## Estado atual (v0.1)

Executa no navegador: ingestão de CSV, TSV, XLS, XLSX, JSON, JSONL e XML; mapeamento inteligente; 12 regras de qualidade; resolução de identidade com revisão humana e decisões reversíveis; golden record com evidência por campo; cinco indicadores e DQI versionado; enriquecimento por derivações internas; governança com isolamento por tenant, RBAC, supressão, correção, eliminação e auditoria.

Os dados do tenant inicial são sintéticos e identificados como tal. O provedor B2B é um adaptador de demonstração.

Ainda não existe: persistência (D1, R2), API publicada, conectores além de arquivo, orquestração durável e agentes Claude no backend.

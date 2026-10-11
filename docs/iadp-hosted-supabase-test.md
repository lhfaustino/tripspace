# Validação IADP em Supabase hospedado isolado

## Limites de segurança

- Projeto de produção atualmente vinculado: `xpzjtipytezqxhapjlak` (`TripSpace`).
- Esse identificador é um destino proibido para os comandos deste procedimento.
- Use um projeto Supabase novo, vazio e explicitamente identificado como teste.
- Não cole senha do banco, chaves `anon`, `publishable` ou `service_role` no chat.
- Não substitua `.env.local`; o desenvolvimento deve usar `.env.development.local`, que não é carregado em produção e permanece ignorado pelo Git.

## 1. Criar o projeto de testes

No dashboard Supabase:

1. Crie um projeto com um nome inequívoco, por exemplo `TripSpace IADP Test`.
2. Use Postgres 17, compatível com `supabase/config.toml`.
3. Guarde a senha do banco em um gerenciador local; não a coloque em arquivo versionado ou em argumentos de shell.
4. Copie somente o **Project Ref** e compare-o com `xpzjtipytezqxhapjlak`. Eles precisam ser diferentes.
5. Em Authentication, mantenha apenas usuários fictícios. Os testes SQL criam usuários dentro de uma transação e fazem rollback.

## 2. Preparar o workdir isolado

O comando abaixo copia somente o schema necessário para um diretório ignorado pelo Git. Ele não modifica `supabase/.temp/project-ref` do TripSpace:

```powershell
node scripts/prepare-supabase-iadp-test-workdir.mjs
```

O pacote contém, nesta ordem:

1. `20260530000000_flight_upload_rls.sql`: tabelas de escala e políticas RLS;
2. `20260609000000_roster_analytics_fields.sql`: campos analíticos usados pelo app;
3. `20260929000000_replace_future_roster_flights.sql`: comportamento PDF anterior;
4. `20261010000000_manual_iadp_import.sql`: identidade IADP, conciliação e RPC transacional.

O seed do workdir é vazio. Migrações de perfil/storage, sociais, conteúdo administrativo e dados do TripSpace não são copiadas. Usuários sintéticos são criados diretamente em `auth.users` dentro da transação pgTAP e descartados pelo rollback.

## 3. Confirmar e vincular somente o projeto de testes

Defina apenas o identificador não secreto na sessão atual do PowerShell:

```powershell
$env:IADP_TEST_PROJECT_REF = "PROJECT_REF_DO_TESTE"
```

Confirme que ele não é produção:

```powershell
if ($env:IADP_TEST_PROJECT_REF -eq "xpzjtipytezqxhapjlak") { throw "Destino de produção recusado" }
supabase projects list -o json
```

Vincule o workdir isolado. O CLI solicitará a senha do banco interativamente; não use `--password` para evitar histórico do shell:

```powershell
supabase --workdir .iadp-analysis/supabase-hosted-test link --project-ref $env:IADP_TEST_PROJECT_REF
```

Confira o identificador gravado no workdir antes de qualquer escrita:

```powershell
$linked = Get-Content .iadp-analysis/supabase-hosted-test/supabase/.temp/project-ref
if ($linked -ne $env:IADP_TEST_PROJECT_REF) { throw "Projeto vinculado não corresponde ao teste" }
if ($linked -eq "xpzjtipytezqxhapjlak") { throw "Destino de produção recusado" }
```

## 4. Fazer preflight e aplicar o schema de teste

Primeiro execute apenas leituras:

```powershell
supabase --workdir .iadp-analysis/supabase-hosted-test migration list --linked
supabase --workdir .iadp-analysis/supabase-hosted-test db push --linked --dry-run
```

O projeto deve estar vazio e o dry-run deve listar somente as quatro migrações acima. Depois de uma segunda conferência do Project Ref, aplique no projeto de testes:

```powershell
supabase --workdir .iadp-analysis/supabase-hosted-test db push --linked
```

## 5. Executar PostgreSQL/RLS

```powershell
supabase --workdir .iadp-analysis/supabase-hosted-test db lint --linked --schema public --fail-on error
supabase --workdir .iadp-analysis/supabase-hosted-test test db --linked
```

`iadp_import.test.sql` roda dentro de `BEGIN/ROLLBACK` e verifica:

- colunas e RPC esperados;
- isolamento RLS entre dois usuários sintéticos;
- recusa de escrita cruzada;
- recusa de execução anônima;
- importação e reimportação idempotente;
- alteração de horário sem duplicação;
- regressão do RPC PDF;
- adoção de um registro PDF por uma identidade IADP;
- preservação de catering durante a conciliação;
- preservação de IADP em reimportação PDF;
- ausência de exclusões quando um evento IADP é omitido.

## 6. Apontar somente o Next.js de desenvolvimento

Copie `.env.development.local.example` para `.env.development.local` e preencha os valores diretamente do dashboard do projeto de testes. Esse arquivo tem prioridade sobre `.env.local` durante `next dev` e não é usado por builds de produção.

Confirme localmente, sem imprimir as chaves:

```powershell
rg "^[A-Za-z_][A-Za-z0-9_]*=" .env.development.local
npm run dev
```

A URL deve conter exatamente o Project Ref de testes. `SUPABASE_SERVICE_ROLE_KEY` é necessária apenas para exercitar o fluxo PDF existente e nunca pode usar a chave do projeto de produção.

## 7. Teste manual da aplicação

1. Crie um usuário fictício no projeto de testes.
2. Entre no TripSpace local com esse usuário.
3. Importe um PDF sintético e confirme que ele continua funcionando.
4. Gere a prévia com `.iadp-analysis/iadp-events-2.anonymized.json`.
5. Confirme a importação e gere novamente a mesma prévia; os registros devem aparecer como inalterados.
6. Não use credenciais, PDFs ou JSONs de produção nesse projeto.

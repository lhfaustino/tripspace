# Descoberta da integração IADP

## Limites desta etapa

Esta etapa documenta evidências estáticas e prepara uma captura local segura. Ela não reutiliza a identidade OAuth de outro cliente, não captura MFA e não implementa endpoints ou renovação de sessão ainda não confirmados.

O upload por PDF continua sendo o fluxo de produção.

## Fluxo atual do TripSpace

1. `RosterUploadCard` envia um ou mais PDFs para a server action `uploadRoster`.
2. A action valida a sessão Supabase e o MIME type.
3. `extractPdfText` extrai o texto e `parseRosterText` converte voos e atividades `FR`/`FP` em registros normalizados.
4. O PDF é salvo no bucket `flight-rosters` e seus metadados em `flight_rosters`.
5. Os registros são enriquecidos com o meal plan e transformados em `flight_leg_details`.
6. A função SQL `replace_user_future_flight_legs` substitui atomicamente os registros a partir da data atual e preserva o histórico anterior.
7. A tela lê `flight_leg_details`, que é a fonte canônica exibida ao usuário.

## Evidências estáticas no CrossCheck 1.5.0

- Pacote: `com.crosscheck.for_crew`, versão `1.5.0` (`versionCode` 96), Flutter, `minSdk` 26 e `targetSdk` 36.
- O APKS contém `base.apk` e o split `split_config.arm64_v8a.apk`; `libapp.so` está no split ARM64.
- SHA-256 do APKS analisado: `943529d8d7f65a5c0168c6b95761e3d62909e80398a164c4a819fd5dd3dd7006`.
- SHA-256 de `libapp.so`: `cce255650166f3aef890fd97f318feda43dd5307c0f99e0fc39bd4f990c074f8`.
- Host encontrado: `https://crewlink.prd.glo.weur.cloud.lhsystems.com`.
- Strings de rota encontradas:
  - `/crew/glo/api/netline/crew/pems/rest/pems/idp/user/roster`
  - `/crew/glo/api/netline/crew/pems/rest/pems/idp/report/v1/dutyplan/download`
  - `/crew/glo/api/netline/crew/pems/rest/pems/login`
- Strings de autenticação incluem o realm `netline`, OpenID Connect, o broker `GOLAD`, `login.microsoftonline.com` e identificadores `CREWLINK`, `NLCREWUI` e `IADP`.
- Há JavaScript injetado na WebView para observar `XMLHttpRequest` e `fetch`, detectar respostas de token e observar headers `Authorization`. O código diferencia tokens cujo claim `azp` é `IADP`.
- Símbolos e strings incluem `dutyRequestIADP`, `crewRequestIADP`, `salaryRequestIADP`, `_iadpRosterJson`, `rosterCobreMes`, `crewModelFromIadpLegs` e funções de polling.
- A proximidade de strings sugere `POST` junto de `dutyRequestIADP` e `GET` junto de `crewRequestIADP`, mas isso não comprova o método de nenhuma rota.

## Lacunas que a análise estática não resolve

- Método HTTP e finalidade exata de cada rota.
- Query params, body, headers obrigatórios e identificador do tripulante.
- Schema, timezone e semântica das respostas.
- Se a escala vem da rota de roster, do download de duty plan ou de ambas.
- Authorization Code/PKCE, scopes, audience, redirect URIs e política de registro de um cliente próprio.
- Existência e regras de refresh token, duração da sessão e revogação.
- ETags, versão da escala, eventos de alteração ou outra estratégia de sincronização incremental.
- Limites de uso e frequência permitida de sincronização.

## Teste local no navegador

Faça o teste somente com sua própria conta e em um computador confiável.

1. Crie a pasta local `.iadp-analysis/` na raiz do projeto. Ela está ignorada pelo Git.
2. Abra o portal oficial no Chrome ou Edge e abra DevTools > Network antes do login.
3. Ative `Preserve log` e `Disable cache`.
4. Faça o login Microsoft e o MFA normalmente. Não copie senha, cookie, código de MFA ou token.
5. Filtre por `crewlink.prd.glo.weur.cloud.lhsystems.com`.
6. Abra a escala mensal, troque para outro mês, volte ao mês original e acione o download do duty plan. Isso diferencia consulta, cobertura de mês e download.
7. Salve a captura como `.iadp-analysis/iadp-session.har`. O HAR bruto é secreto e não deve ser enviado nem commitado.
8. Gere um resumo estrutural sanitizado:

   ```bash
   npm run iadp:inspect-har -- .iadp-analysis/iadp-session.har
   ```

9. O resultado fica em `.iadp-analysis/iadp-protocol-summary.json`. O sanitizador remove cookies e valores de headers sensíveis, não imprime bodies e conserva apenas métodos, nomes/formato de parâmetros e schemas JSON.
10. Antes de compartilhar qualquer resumo, procure por `Bearer`, `eyJ`, `cookie`, seu e-mail e seu código de tripulante. O HAR bruto deve permanecer local.

## Critério para iniciar a implementação

A implementação pode começar quando a captura confirmar as chamadas de roster e download e quando houver um cliente OAuth próprio autorizado para o TripSpace (redirect URI, scopes e política de refresh definidos). A camada IADP então deverá produzir o mesmo modelo canônico consumido hoje pelo fluxo PDF, preservando o PDF como alternativa.

## Protocolo confirmado pela captura local

A captura de 10 de outubro de 2026 confirmou o seguinte fluxo, sem registrar valores de credenciais nesta documentação:

1. O portal lê o discovery document do realm `netline`.
2. São executados dois fluxos OIDC `authorization_code` com PKCE: primeiro para o app frame e depois para o módulo IADP. Cada token tem o próprio `azp`.
3. O access token observado tem duração de 720 segundos. A resposta também contém refresh token, mas o grant de renovação não apareceu na captura e sua política ainda não está validada.
4. O módulo chama `POST /crew/glo/api/netline/crew/pems/rest/pems/login` e recebe configuração, `crmId`, dados básicos do tripulante e credenciais internas compostas por `roles` e `userId`.
5. A escala completa é carregada por `GET /crew/glo/api/netline/crew/pems/rest/pems/idp/user/roster/{crewCode}/events`.
6. A resposta de `events` contém `rosterPeriod`, `blockMonthList` e eventos. Pairings possuem eventos filhos; legs filhos expõem `flightNumber`, aeroportos, horários UTC/locais e tipo de aeronave em `eventDescription`.
7. Alterações são consultadas por `GET /crew/glo/api/netline/crew/pems/rest/pems/idp/user/roster/{crewCode}/updates`. Na amostra, o polling ocorreu aproximadamente a cada 15 segundos e retornou `lastRosterChange`, `lastDailyRemarkTimestamp`, `roster` e `checkins`.
8. Observações diárias usam `GET .../details/daily_remark?fromDtUtc=...&toDtUtc=...`.

O endpoint de download do duty plan não apareceu nesta captura. Também não houve uma troca de refresh token, portanto nenhum desses comportamentos deve ser implementado por suposição.

O discovery document anuncia Authorization Code, refresh token e PKCE `S256`, além de um endpoint de registro dinâmico. A existência desse endpoint não autoriza o TripSpace a registrar um cliente automaticamente. É necessária autorização da GOL/Lufthansa Systems e uma identidade OAuth própria, com redirect URIs e origens do TripSpace aprovadas.

O normalizador independente de transporte está implementado em `lib/iadp/normalize-roster-events.ts`. Ele usa somente fixtures sintéticas, achata pairings, normaliza fusos, representa atividades no formato atual e calcula inclusões, alterações e remoções entre snapshots completos. Autenticação e chamadas reais permanecem deliberadamente fora dessa camada.

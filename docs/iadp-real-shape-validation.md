# Validação do normalizador contra o formato observado

## Fidelidade do resumo sanitizado

O resumo produzido por `sanitize-iadp-har.mjs` não é uma fixture completa. Por segurança e tamanho, ele limita arrays aos primeiros 20 elementos, limita schemas distintos por array e substitui todos os valores. Ele é adequado para descoberta, mas não para provar cobertura integral de `/events`.

Para a validação local foi adicionado `anonymize-iadp-events-har.mjs`. O script:

- seleciona somente a última resposta `200` da rota `/events`;
- não copia requests, headers, cookies ou respostas OIDC;
- pseudonimiza IDs com HMAC-SHA-256 e uma chave aleatória mantida somente em `.iadp-analysis/iadp-anonymization-salt`;
- produz o mesmo pseudônimo para o mesmo valor original em capturas diferentes, independentemente da ordem dos eventos, desde que a mesma chave local seja reutilizada;
- não permite obter o ID original a partir da fixture sem a chave local;
- desloca os anos das datas, preservando offsets e relações temporais;
- falha se encontrar JWT, Bearer, e-mail ou campos conhecidos de autenticação/identificação;
- grava a fixture somente em `.iadp-analysis/`, que permanece fora do Git.

Não apague nem compartilhe `iadp-anonymization-salt` entre as duas anonimizações. Uma chave nova gera pseudônimos diferentes; a chave não deve ser anexada, commitada ou colada no chat.

## Captura de dois snapshots do mesmo mês

1. Abra o portal normalmente no navegador e conclua o login e MFA por conta própria.
2. Nas ferramentas do desenvolvedor, abra **Network**, habilite **Preserve log** e filtre por `/events`.
3. Selecione no portal exatamente o mesmo mês da primeira captura. Force uma recarga legítima pela interface (por exemplo, troque de mês e volte), sem editar nem reproduzir manualmente a requisição.
4. Confirme que surgiu uma resposta `200` de `/events`. Exporte o HAR com conteúdo e salve-o como `.iadp-analysis/iadp-session-2.har`. O HAR bruto permanece local e não deve ser compartilhado.
5. Anonimize cada captura usando a mesma chave local:

```bash
npm run iadp:anonymize-events -- .iadp-analysis/iadp-session.har .iadp-analysis/iadp-events-1.anonymized.json
npm run iadp:anonymize-events -- .iadp-analysis/iadp-session-2.har .iadp-analysis/iadp-events-2.anonymized.json
```

6. Compare as fixtures anonimizadas:

```bash
npm run iadp:compare-snapshots -- .iadp-analysis/iadp-events-1.anonymized.json .iadp-analysis/iadp-events-2.anonymized.json
```

O relatório detalhado fica em `.iadp-analysis/iadp-snapshot-comparison.json`. Ele contém apenas valores já anonimizados e relata estabilidade de `logicalId + id`, inclusões, alterações, candidatos a remoção, mudanças aparentes de identidade e correspondência dos períodos.

## Estrutura real anonimizada já validada

- 59 eventos no nível superior.
- 3 containers de pairing com eventos filhos.
- 104 eventos folha.
- 19 legs com `eventDescription.flightNumber`.
- 85 atividades.
- 104 de 104 folhas normalizadas, sem warnings.
- Timestamps UTC e locais foram observados com offset explícito; o normalizador aceita `Z` e offsets.
- Uma folha não possuía aeroporto de saída/chegada; o modelo usa `-` sem perder o registro.
- Duas atividades distintas compartilhavam data, horário, código e `logicalId`, mas possuíam `id` diferente.

As duas últimas características não estavam cobertas pela fixture sintética inicial. A identidade IADP foi ajustada para combinar `logicalId + id` e gerar um token estável na `unique_key`. Isso evita colisão entre atividades simultâneas e remove o horário da identidade persistente, permitindo que uma mudança de horário seja tratada como atualização.

## Identidade no importador PDF

O fluxo PDF atual usa:

- voo: data + número + origem + destino + horário de partida;
- atividade: data + código + horário.

Uma alteração de horário muda a chave. Hoje isso não duplica durante o upload PDF porque `replace_user_future_flight_legs` apaga e reinsere atomicamente todos os registros do usuário a partir da data de corte. Essa segurança depende da substituição completa; um upsert incremental com a mesma chave não seria suficiente.

O IADP não deve usar a função SQL atual para aplicar snapshots mensais, pois ela cobre todo o futuro, não apenas o período do snapshot. Nesta etapa nenhum dado IADP é persistido.

## Prévia e proteção contra remoções

`buildIadpImportPreview` produz, sem acesso ao banco, inclusões, alterações, registros inalterados e candidatos a remoção limitados ao usuário e ao período informados.

Os critérios abaixo comprovam apenas consistência interna do conteúdo recebido:

1. `success` superior e `result.success` são `true`;
2. `events` existe, é array e não está vazio;
3. `rosterPeriod` possui início/fim válidos e crescentes;
4. todas as folhas foram normalizadas;
5. as identidades de origem são únicas;
6. não houve warning de parsing ou colisão.

Eles não comprovam que o servidor enviou a escala completa. Por isso, `removalSafe` permanece sempre `false`, `removals` permanece vazio e toda ausência é apresentada somente em `suppressedRemovals`/`removalCandidates`. Resposta parcial, erro, período divergente ou falha de parsing acrescentam bloqueios, mas a ausência desses problemas não libera exclusões automáticas.

Antes de qualquer persistência futura será necessária uma prova independente de completude, como semântica documentada/contratada pelo fornecedor ou uma confirmação explícita e segura do usuário. Nenhuma mutação no banco foi implementada.

## Pontos ainda hipotéticos

- Há somente um snapshot completo real analisado até agora. A estabilidade de `logicalId + id` entre duas cargas reais ainda não foi comprovada.
- Inclusões, alterações e remoções foram exercitadas com fixtures sintéticas, não com dois snapshots reais consecutivos.
- Não foi comprovado se o servidor pode responder `success: true` com um snapshot funcionalmente parcial.
- A transação SQL futura, limitada por `user_id` e `rosterPeriod`, ainda não foi implementada.

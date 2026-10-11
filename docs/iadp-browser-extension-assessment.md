# Avaliação de integração IADP por extensão de navegador

## 1. O que o HAR confirmou tecnicamente

- O portal executa dois fluxos OIDC `authorization_code` com PKCE, para clientes distintos do app frame e do módulo IADP.
- O access token observado dura 720 segundos. A resposta contém refresh token, mas nenhuma renovação foi capturada.
- Após os fluxos OIDC, o portal chama `POST .../pems/login`.
- A carga completa da escala usa `GET .../user/roster/{crewCode}/events`.
- Pairings contêm eventos filhos. Legs filhos incluem número do voo, aeroportos, horários UTC/locais e aeronave.
- `GET .../user/roster/{crewCode}/updates` funcionou como sinal de alteração, com polling próximo de 15 segundos na amostra.
- A captura sanitizada não preservou headers de autenticação das chamadas de API. Portanto, o HAR não prova sozinho qual token/header autoriza cada chamada.
- O download do duty plan e o grant de refresh não apareceram na captura.

## 2. O que decorre da restrição do projeto

Por decisão de segurança e identidade do produto, o TripSpace não irá:

- usar os client IDs, redirect URIs ou tokens dos clientes existentes;
- reproduzir a captura de Bearer token feita pelo CrossCheck;
- registrar dinamicamente um cliente no realm;
- contornar MFA, políticas de origem ou controles do portal.

Essa restrição impede hoje um conector direto hospedado pelo TripSpace. Ela não torna desconhecido o formato da escala e não impede desenvolver o normalizador independente de transporte.

## 3. O que depende do fornecedor

Somente a GOL/Lufthansa Systems pode confirmar:

- se integrações de terceiros e extensões de navegador são permitidas pelos termos e políticas internas;
- se o TripSpace pode receber uma identidade OAuth própria;
- scopes, audience, redirect URIs, origens, refresh e revogação autorizados;
- limites de polling, automação e armazenamento dos dados da escala;
- se existe uma API, exportação ou parceria suportada que seja preferível à automação do portal.

A presença de endpoints no HAR ou no discovery document não concede autorização para utilizá-los.

## Viabilidade de uma extensão acionada pelo usuário

### Opção tecnicamente mais defensável

Uma extensão Manifest V3 poderia usar `activeTab` e `scripting` somente depois de um clique explícito do usuário no portal. A extensão observaria exclusivamente a próxima resposta de `.../events`, extrairia os dados da escala — não headers, cookies ou tokens — mostraria uma prévia e exigiria confirmação antes de enviá-los ao TripSpace.

Para entregar os dados sem dar credenciais do TripSpace à extensão, ela poderia abrir uma página de importação do TripSpace. Essa página, já autenticada pelo usuário, receberia uma mensagem com origem e nonce validados e faria a mutação no próprio backend. Uma alternativa mais simples é a extensão gerar um arquivo JSON local que o usuário importa manualmente.

Essa arquitetura é tecnicamente plausível, mas ainda não foi validada no portal real. Um protótipo teria de provar que:

1. a instrumentação instalada após o clique consegue observar uma nova carga de `events`;
2. o portal continua funcionando com a instrumentação;
3. nenhum dado de autenticação atravessa a ponte da página para a extensão;
4. apenas o schema de escala permitido é transmitido;
5. a importação no TripSpace exige uma confirmação visível e uma sessão própria válida.

### Limitações técnicas

- `activeTab` concede acesso temporário e somente após gesto do usuário. Isso combina com importação manual, não com sincronização autônoma em background.
- Content scripts usam um mundo isolado por padrão: compartilham o DOM, mas não as variáveis JavaScript da página.
- Um script no mundo `MAIN` pode observar `fetch`/XHR da página, mas divide o ambiente com código do portal, fica sujeito à CSP da página e pode ser interferido por ela.
- Observar `webRequest` não fornece de forma geral o corpo das respostas. Portanto, isso não resolve sozinho a leitura de `events`.
- Fazer requisições pela service worker da extensão exigiria host permissions e uma forma própria de autenticação. A sessão do portal não deve ser presumida como reutilizável e extrair token está fora do desenho.
- Sem acesso persistente, a extensão só sincroniza enquanto a página e a autorização temporária estiverem ativas. Com acesso persistente, as permissões e o risco aumentam.
- O frontend do portal pode mudar sem aviso. Uma integração baseada em instrumentação é mais frágil que uma API suportada.

### Privacidade, distribuição e autorização

Segundo a documentação do Chrome, conteúdo de páginas, dados obtidos de requisições e identificadores pessoais são dados sensíveis para extensões. Uma distribuição pela Chrome Web Store exigiria propósito único, permissões mínimas, política de privacidade, divulgação do tratamento, consentimento e transporte seguro.

Essas exigências do navegador são adicionais às regras da GOL/Lufthansa Systems. Aprovação na Chrome Web Store não equivale a autorização do fornecedor para observar ou transmitir dados do portal.

Referências oficiais:

- [Chrome: permissão activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome: content scripts e mundos isolados](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome: requisições cross-origin em extensões](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome Web Store: políticas de dados do usuário](https://developer.chrome.com/docs/webstore/user_data)
- [Chrome Web Store: Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)

## Recomendação

Manter duas trilhas separadas:

1. buscar autorização/documentação para um conector OAuth oficial;
2. somente com aprovação organizacional, construir um protótipo local e não distribuído da extensão, limitado a importação explícita e sem captura de autenticação.

Até uma dessas trilhas ser validada, o PDF permanece o único transporte de produção.

# Importação manual IADP

## Fluxo

O modal **Enviar Escala** aceita, além dos PDFs existentes, uma fixture JSON IADP anonimizada. O JSON passa por duas ações separadas:

1. **Gerar prévia** autentica o usuário, normaliza o snapshot e consulta somente os registros pertencentes a `auth.getUser().id`.
2. A interface mostra inclusões, alterações, inalterados e candidatos informativos a remoção.
3. **Salvar importação IADP** exige um checkbox explícito, reenvia o mesmo arquivo, recalcula a prévia e compara um digest que inclui o arquivo e o estado atual do banco.
4. O RPC transacional grava apenas inclusões e alterações. Não existe operação de exclusão no fluxo IADP.

O arquivo enviado nunca fornece `user_id`. O preview usa o cliente Supabase da sessão com RLS; o RPC obtém o usuário novamente por `auth.uid()` e não recebe um identificador de usuário como argumento.

A interface e as duas ações recusam o fluxo quando `NODE_ENV=production`. O importador PDF não possui essa restrição e continua funcionando normalmente.

## Identidade e conciliação

- `source_event_id` guarda `logicalId + id` separadamente dos campos editáveis.
- Horários, rota, equipamento e demais campos podem mudar sem alterar essa identidade.
- A primeira importação procura um único registro PDF da mesma operação.
- Para voos, a chave de conciliação usa data local, tipo, número e rota.
- Para atividades, inclui também o horário local porque podem existir várias atividades com o mesmo código no mesmo dia.
- Se houver mais de um candidato PDF, nenhum é adotado automaticamente.
- Quando há um único candidato, a linha PDF é convertida em IADP na mesma transação, preservando serviço/refeição já associados.
- Reimportações localizam a linha por `(user_id, source_event_id)` e são idempotentes.

O RPC do PDF continua disponível. Após a migração, ele substitui somente linhas `roster_source = 'pdf'` e não reinsere uma operação já representada por IADP. Assim, o PDF permanece como fallback sem apagar a identidade IADP.

## Migração pendente

`20261010000000_manual_iadp_import.sql` adiciona metadados de origem, índices e os RPCs transacionais. Ela não foi executada em ambiente local ou remoto. Antes de habilitar o botão de gravação em qualquer ambiente, a migração deve ser revisada e testada em uma instância Supabase local isolada.

O ambiente Docker/Supabase local não estava disponível durante esta implementação. Portanto, foram executados testes unitários do planejamento, isolamento e idempotência, mas o teste de integração PostgreSQL/RLS permanece pendente. Nenhuma migração ou importação foi executada em produção.

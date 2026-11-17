# As 48 tabelas novas do banco real (versão 1.113)

Registrado em 17/11/2026. São as tabelas que o banco real **não tinha** (vinha do projeto antigo, versão 1.70) e que entraram quando o `baseline.sql` da base nova foi aplicado. Nenhuma foi criada por nós: são recursos da versão 1.113 do original.

**Como foi medido:** lista de tabelas do `public` no backup feito ANTES da atualização (193 tabelas) comparada com as `create table` do `supabase/baseline.sql` (203), menos os 9 módulos opcionais abaixo. Descrição = o comentário que o próprio banco guarda; onde não há comentário está marcado *(pelo nome)* e NÃO foi confirmado.

Backup de antes da atualização: `C:/Users/Dannilo/Documents/backups-supabase/` (`.dump` de `public`, `auth`, `storage`).

> Elas não são "funções da Ruby". São recursos do CRM; poucos a Ruby usa. Algumas áreas (cobrança, agências) só aparecem na tela quando o módulo é ligado.

## Ruby e IA (10)
| Tabela | O que é |
|---|---|
| `agent_turn_traces` | Uma linha por execução do agente (issue #2869). |
| `ai_agent_mcp_servers` | Servidores MCP externos de UM agente (até 5). Só o servidor acessa. |
| `ai_agent_version_channels` | Em quais números uma versão de agente atende (um, vários ou todos). |
| `contato_mcp_credenciais` | Token OAuth de UM contato para UM servidor MCP externo, cifrado. |
| `mcp_oauth_pedidos` | Pedido de autorização OAuth de uso único, amarrado ao contato e à conversa. |
| `jev_router_decisions` | *(pelo nome)* decisões do Jev, o auxiliar de decisão da IA. |
| `lead_field_proposals` | Campo do card que a IA leu num documento (voucher, bilhete, apólice) e propôs, aguardando confirmação humana. |
| `crm_materiais` | Material pronto da empresa (catálogo em PDF, tabela de preços, ficha) que o agente envia na conversa. |
| `crm_materiais_do_agente` | Quais materiais cada agente pode enviar (#4129). |
| `pagamento_recebimentos` | Recebimento do cliente final registrado na conversa e o desfecho do aviso do provedor (#3509). |

## Catálogo (2)
| Tabela | O que é |
|---|---|
| `catalog_feed_sources` | A fonte do catálogo sincronizado: URL do feed, formato e mapeamento (#3587). |
| `catalog_product_presentations` | Como a IA apresenta um item do catálogo, 1:1 e opcional. |

## Atendimento e equipe (7)
| Tabela | O que é |
|---|---|
| `attendant_sectors` | Setores de atendimento da organização (nome único). |
| `attendant_sector_members` | Vínculo atendente → fila; N filas por atendente. |
| `conversation_participants` | *(pelo nome)* atendimento conjunto numa conversa. |
| `message_template_groups` | Grupos opcionais de respostas rápidas (#3245). |
| `mensagens_agendadas` | *(pelo nome)* mensagem agendada para sair depois. |
| `satisfacao_do_atendimento` | Pedido de nota 1 a 5 ao encerrar o atendimento (#4023). |
| `channel_schedules` | *(pelo nome)* horários por número/canal. |

## Agenda (10)
| Tabela | O que é |
|---|---|
| `calendar_resources`, `calendar_service_blocks`, `calendar_service_calendar_sources`, `calendar_service_occurrence_resources`, `calendar_service_occurrences`, `calendar_service_professionals`, `calendar_service_resources`, `calendar_service_schedule` | *(pelo nome)* recursos, profissionais, horários de atendimento, bloqueios e ocorrências da agenda de serviços. |
| `config_aviso_de_agendamento` | Aviso de agendamento no WhatsApp do dono (0753), uma linha por organização. |
| `entregas_de_aviso_de_agendamento` | Uma linha por evento de agenda avisado e uma por resumo diário. |

## Vendas e CRM (8)
| Tabela | O que é |
|---|---|
| `crm_metas` | Meta mensal por indicador; `pipeline_id` nulo = meta da empresa (#3025). |
| `tabelas_de_valores` | Tabela de valores de negociação (credenciamento, fornecedores, serviços com tabela). |
| `tabela_de_valores_itens` | Procedimento de uma tabela de valores: código, descrição, valor de partida e limite. |
| `tabela_de_valores_importacoes` | Uma linha por importação confirmada de planilha (chave SHA-256 do arquivo). |
| `crm_lead_attachments` | *(pelo nome)* anexos do card. |
| `contact_phones` | *(pelo nome)* vários telefones por contato. |
| `importacoes_de_historico` | *(pelo nome)* importação de histórico de conversas. |
| `avisos` | Sem descrição no banco; não confirmado. |

## Automação (2)
| Tabela | O que é |
|---|---|
| `automation_rodizio_atribuicoes` | Histórico do rodízio da ação `assign_owner`: quem recebeu cada lead e em que posição da fila (#2041). |
| `automation_rule_contact_claims` | Reserva para a opção "no máximo uma vez por contato" (#2974). |

## Cobrança do SaaS (2) — módulo desligado por padrão
| Tabela | O que é |
|---|---|
| `cobranca_planos` | Planos que o dono da instalação vende às empresas dele (da instalação, sem `organization_id`). |
| `cobranca_assinaturas` | Assinatura de cada empresa (uma linha por org; sem linha = isenta). |

## Agências (4)
`agencia_clientes`, `agencia_configuracoes`, `agencia_criacoes`, `agencia_sessoes` — *(pelo nome)* gestão de clientes de terceiros por agências. Sem descrição no banco; só existe com o módulo `agencias` ligado.

## Segurança e anúncios (3)
| Tabela | O que é |
|---|---|
| `lgpd_marcas_de_apagamento` | *(pelo nome)* marcas do apagamento LGPD. |
| `mfa_trusted_devices` | *(pelo nome)* dispositivos confiáveis do segundo fator. |
| `meta_ctwa_click_dispatches` | Evidência e livro-razão do LeadSubmitted por clique em anúncio que abre o WhatsApp (CTWA). Só o servidor acessa. |

---

## Os 9 que AINDA NÃO existem (módulos opcionais, só nascem ao instalar)
- **Honorários** (2): `honorarios_contratos`, `honorarios_parcelas`.
- **Ouvidoria** (1): `ouvidoria_manifestacoes`.
- **Lista de espera da agenda** (1): `calendar_waitlist` — **o dono quer instalar depois que tudo terminar, com ferramenta para a Ruby usar.** Rotas REST já existem; a ferramenta da Ruby não.
- **Cadências de e-mail** (5): `email_cadences`, `email_cadence_enrollments`, `email_cadence_events`, `email_cadence_suppressions`, `email_cadence_recipients` — exige envio de e-mail configurado (hoje vazio).

Decisão do dono em 17/11/2026: nenhum por enquanto, exceto a lista de espera (depois).

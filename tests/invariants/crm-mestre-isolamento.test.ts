import { describe, expect, it } from "vitest";

import { countAs, GOV_ADMIN, GOV_AGENT_A, GOV_ORG, seedGov, sql, writeCountAs } from "./gov-helpers";

/**
 * O CRM mestre (migrations 9393, 9394 e 9395): a prova COMPORTAMENTAL que a varredura de
 * completude de RLS exige para tabela tenant-aware nova.
 *
 * Duas famílias, e a diferença entre elas é o ponto:
 *
 *  1. `platform_customer_*` (conta comercial do cliente) são EXCLUSIVAS DO SERVIDOR: RLS de pé,
 *     nenhuma policy e NENHUM privilégio para `anon`/`authenticated` — nem da própria
 *     organização. Quem lê e escreve é a rota de plataforma, com `service_role`, depois de
 *     `requirePlatformAdmin`. Elas não entram em TABLES porque o usuário do teste não tem
 *     SELECT: o controle positivo de lá falharia por ACERTO.
 *  2. `mcp_external_connections` é por organização: o admin da PRÓPRIA organização lê e
 *     escreve; o agente não escreve; outra organização não enxerga.
 */
const PLATAFORMA = [
  "platform_customer_accounts",
  "platform_customer_products",
  "platform_customer_payments",
  "platform_customer_notes",
] as const;

const OUTRA_ORG = "dddddddd-0000-4000-8000-0000000000a1";
const CONEXAO_A = "dddddddd-0000-4000-8000-0000000000b1";
const CONEXAO_B = "dddddddd-0000-4000-8000-0000000000b2";

describe("CRM mestre: tabelas da plataforma são só do servidor", () => {
  it.each(PLATAFORMA)("%s: RLS ligada e sem policy — sem policy, ninguém do navegador passa", (t) => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).toBe("t");
    expect(
      sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}'`),
    ).toBe("0");
  });

  it.each(PLATAFORMA)("%s: anon e authenticated sem privilégio, service_role com", (t) => {
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, 'public.${t}', p))
           from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p`,
      ),
    ).toBe("t");
    expect(sql(`select has_table_privilege('service_role', 'public.${t}', 'select')`)).toBe("t");
    expect(sql(`select has_table_privilege('service_role', 'public.${t}', 'insert')`)).toBe("t");
  });

  it("authenticated JWT de admin da própria org também é recusado (não é só cross-tenant)", () => {
    seedGov();
    expect(() => countAs(GOV_ADMIN, "select count(*) from public.platform_customer_accounts;")).toThrow();
  });
});

describe("CRM mestre: conexões MCP externas isolam por organização", () => {
  it("o admin lê as da própria organização e não enxerga as de outra", () => {
    seedGov();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${OUTRA_ORG}', 'mcp-outra', 'Outra Org', 'Outra')
        on conflict do nothing;
      insert into public.mcp_external_connections (id, organization_id, label, url)
        values ('${CONEXAO_A}', '${GOV_ORG}', 'EVO da org A', 'https://exemplo-a.example.com/mcp'),
               ('${CONEXAO_B}', '${OUTRA_ORG}', 'EVO da org B', 'https://exemplo-b.example.com/mcp')
        on conflict do nothing;
    `);
    // Controle positivo: ele enxerga a PRÓPRIA — sem isto, "0 da outra" passaria por tabela ilegível.
    expect(
      countAs(GOV_ADMIN, `select count(*) from public.mcp_external_connections where id = '${CONEXAO_A}';`),
    ).toBe(1);
    expect(
      countAs(GOV_ADMIN, `select count(*) from public.mcp_external_connections where id = '${CONEXAO_B}';`),
    ).toBe(0);
  });

  it("agente não escreve; admin escreve só na própria organização", () => {
    seedGov();
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.mcp_external_connections (organization_id, label, url)
           values ('${GOV_ORG}', 'tentativa do agente', 'https://exemplo-c.example.com/mcp')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_ADMIN,
        `insert into public.mcp_external_connections (organization_id, label, url)
           values ('${GOV_ORG}', 'EVO do admin ${Date.now()}', 'https://exemplo-d.example.com/mcp')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_ADMIN,
        `insert into public.mcp_external_connections (organization_id, label, url)
           values ('${OUTRA_ORG}', 'invasão', 'https://exemplo-e.example.com/mcp')`,
      ),
    ).toBe(0);
  });
});

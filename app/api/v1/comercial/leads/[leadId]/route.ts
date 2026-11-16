import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A aba "Comercial" do card do cliente, no CRM mestre (migration 9395).
 *
 * O card é um negócio (`crm_leads`) do funil de clientes da plataforma. A conta
 * comercial é da EMPRESA-cliente (`platform_customer_accounts`); esta rota só diz
 * se o card tem a aba, a que empresa ele está ligado, e liga/desliga.
 *
 * A aba só existe quando as três coisas são verdade: quem pede é platform admin;
 * o card é de uma organização marcada `settings.plataforma_propria`; e o funil do
 * card é o funil de clientes (`is_client_pipeline`). Nos demais casos a resposta é
 * `habilitado: false` — nunca 403 —, para o dossiê de qualquer outro card seguir
 * sem aba e sem erro.
 *
 * Service role ignora RLS: o `organization_id` do card sai da PRÓPRIA linha lida
 * pelo id do caminho, e toda consulta seguinte o filtra.
 */

type Admin = ReturnType<typeof createAdminClient>;
type Ctx = { params: Promise<{ leadId: string }> };

async function cardDoClientes(admin: Admin, leadId: string) {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return null;

  const [{ data: org }, { data: funil }] = await Promise.all([
    admin.from("organizations").select("id, settings").eq("id", lead.organization_id).maybeSingle(),
    admin
      .from("crm_pipelines")
      .select("id, is_client_pipeline")
      .eq("id", lead.pipeline_id)
      .eq("organization_id", lead.organization_id)
      .maybeSingle(),
  ]);
  const settings = (org?.settings ?? {}) as { plataforma_propria?: unknown };
  if (settings.plataforma_propria !== true || funil?.is_client_pipeline !== true) return null;
  return lead;
}

async function vinculoDoCard(admin: Admin, leadId: string) {
  const { data: conta } = await admin
    .from("platform_customer_accounts")
    .select("id, organization_id")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (!conta) return null;
  const { data: empresa } = await admin
    .from("organizations")
    .select("id, display_name")
    .eq("id", conta.organization_id)
    .maybeSingle();
  return empresa ? { organization_id: empresa.id as string, display_name: empresa.display_name as string } : null;
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const requestId = randomUUID();
  const { leadId } = await params;
  try {
    await requirePlatformAdmin();
  } catch {
    return ok({ habilitado: false }, { requestId });
  }
  if (!z.string().uuid().safeParse(leadId).success) return ok({ habilitado: false }, { requestId });

  const admin = createAdminClient();
  const card = await cardDoClientes(admin, leadId);
  if (!card) return ok({ habilitado: false }, { requestId });

  const vinculo = await vinculoDoCard(admin, leadId);
  if (vinculo) return ok({ habilitado: true, vinculo, empresas: [] }, { requestId });

  // Sem vínculo: oferece as empresas-cliente que ainda não têm card. A própria
  // plataforma não é cliente de si mesma, e quem já está ligado a outro card sai.
  const [{ data: empresas }, { data: ligadas }] = await Promise.all([
    admin
      .from("organizations")
      .select("id, display_name, settings")
      .order("display_name", { ascending: true })
      .limit(500),
    admin.from("platform_customer_accounts").select("organization_id").not("lead_id", "is", null),
  ]);
  const jaLigadas = new Set((ligadas ?? []).map((l) => l.organization_id as string));
  const oferta = (empresas ?? [])
    .filter((e) => (e.settings as { plataforma_propria?: unknown } | null)?.plataforma_propria !== true)
    .filter((e) => !jaLigadas.has(e.id as string))
    .map((e) => ({ id: e.id as string, display_name: e.display_name as string }));
  return ok({ habilitado: true, vinculo: null, empresas: oferta }, { requestId });
}

const ligarSchema = z.object({ organization_id: z.string().uuid() }).strict();

export async function PUT(req: NextRequest, { params }: Ctx) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { leadId } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  if (!z.string().uuid().safeParse(leadId).success) return fail("validation_error", "id inválido", 400, { requestId });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "JSON inválido", 400, { requestId });
  }
  const parsed = ligarSchema.safeParse(body);
  if (!parsed.success) return fail("validation_error", "Dados inválidos", 400, { requestId });

  const admin = createAdminClient();
  const card = await cardDoClientes(admin, leadId);
  if (!card) return fail("not_found", "Este card não tem a aba Comercial", 404, { requestId });

  const empresaId = parsed.data.organization_id;
  const { data: empresa } = await admin
    .from("organizations")
    .select("id, settings")
    .eq("id", empresaId)
    .maybeSingle();
  if (!empresa || (empresa.settings as { plataforma_propria?: unknown } | null)?.plataforma_propria === true) {
    return fail("not_found", "Cliente não encontrado", 404, { requestId });
  }

  // O card já ligado a OUTRA empresa precisa ser desligado antes: um card, uma empresa.
  const atual = await vinculoDoCard(admin, leadId);
  if (atual && atual.organization_id !== empresaId) {
    return fail("conflict", "Este card já está ligado a outra empresa. Desligue antes.", 409, { requestId });
  }

  const { data: existente } = await admin
    .from("platform_customer_accounts")
    .select("id, lead_id")
    .eq("organization_id", empresaId)
    .maybeSingle();
  if (existente?.lead_id && existente.lead_id !== leadId) {
    return fail("conflict", "Esta empresa já está ligada a outro card.", 409, { requestId });
  }

  const escrita = existente
    ? await admin
        .from("platform_customer_accounts")
        .update({ lead_id: leadId, updated_at: new Date().toISOString() })
        .eq("id", existente.id)
        .eq("organization_id", empresaId)
        .select("id")
        .single()
    : await admin
        .from("platform_customer_accounts")
        .insert({ organization_id: empresaId, lead_id: leadId })
        .select("id")
        .single();
  if (escrita.error) {
    if (escrita.error.code === "23505") {
      return fail("conflict", "Esta empresa ou este card já está ligado.", 409, { requestId });
    }
    return fail("internal_error", "Não foi possível ligar", 500, { requestId });
  }

  void audit({
    action: "platform_admin.customer_account_linked",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: empresaId,
    resourceType: "platform_customer_account",
    resourceId: escrita.data.id as string,
    requestId,
    metadata: { lead_id: leadId },
  });
  return ok({ vinculo: await vinculoDoCard(admin, leadId) }, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { leadId } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  if (!z.string().uuid().safeParse(leadId).success) return fail("validation_error", "id inválido", 400, { requestId });

  const admin = createAdminClient();
  const card = await cardDoClientes(admin, leadId);
  if (!card) return fail("not_found", "Este card não tem a aba Comercial", 404, { requestId });

  const { data: conta } = await admin
    .from("platform_customer_accounts")
    .select("id, organization_id")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (!conta) return ok({ vinculo: null }, { requestId });

  const { error } = await admin
    .from("platform_customer_accounts")
    .update({ lead_id: null, updated_at: new Date().toISOString() })
    .eq("id", conta.id)
    .eq("organization_id", conta.organization_id);
  if (error) return fail("internal_error", "Não foi possível desligar", 500, { requestId });

  void audit({
    action: "platform_admin.customer_account_unlinked",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: conta.organization_id as string,
    resourceType: "platform_customer_account",
    resourceId: conta.id as string,
    requestId,
    metadata: { lead_id: leadId },
  });
  return ok({ vinculo: null }, { requestId });
}

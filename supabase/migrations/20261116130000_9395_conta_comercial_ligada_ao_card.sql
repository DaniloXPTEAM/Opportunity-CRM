-- manifest: **Liga a conta comercial do cliente ao card dele no CRM mestre (`platform_customer_accounts.lead_id`).** A aba "Comercial" do dossiê do negócio precisa saber a qual empresa-cliente o card corresponde; a ligação é uma FK nula por padrão (card sem vínculo continua válido) e única (um card, uma empresa).
alter table public.platform_customer_accounts
  add column if not exists lead_id uuid references public.crm_leads(id) on delete set null;

create unique index if not exists platform_customer_accounts_lead_uidx
  on public.platform_customer_accounts (lead_id)
  where lead_id is not null;

comment on column public.platform_customer_accounts.lead_id is
  'O card (crm_leads) do funil de clientes da plataforma que representa esta empresa. Nulo = ainda não ligado.';

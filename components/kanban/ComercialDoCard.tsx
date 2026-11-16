"use client";

import { useState } from "react";

import { CartaoDoCliente } from "@/components/admin/tenants/CartaoDoCliente";
import { ConhecimentoDoCliente } from "@/components/admin/tenants/ConhecimentoDoCliente";
import { Button } from "@/components/ui/button";
import { useComercialDoCard, useLigacaoDoCard } from "@/hooks/useComercialDoCard";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { SecaoDoDossie, type IdDeSecao } from "./SecaoDoDossie";

/**
 * A aba "Comercial" do card do cliente — o CRM mestre DENTRO do CRM, e não uma
 * porta à parte. Mostra onde o cliente está (fase, pagamento, vigência, produtos,
 * pagamentos, observações) e deixa alimentar o conhecimento da Ruby dele.
 *
 * Some sozinha (`null`) em todo card que não é do funil de clientes da plataforma:
 * quem decide é o servidor (`/api/v1/comercial/leads/{id}`), nunca esta tela.
 */
function ConteudoComercial({
  leadId,
  recolhida,
  aoAlternar,
}: {
  leadId: string;
  recolhida: boolean;
  aoAlternar: (id: IdDeSecao) => void;
}) {
  const t = useT();
  const { data } = useComercialDoCard(leadId);
  const { ligar, desligar } = useLigacaoDoCard(leadId);
  const [escolhida, setEscolhida] = useState("");

  if (!data?.habilitado) return null;
  const vinculo = data.vinculo ?? null;

  return (
    <SecaoDoDossie id="comercial" titulo={t("Comercial")} recolhida={recolhida} aoAlternar={aoAlternar}>
      {vinculo ? (
        <div className="flex flex-col gap-4" data-testid="comercial-do-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              {t("Empresa")}: <span className="font-medium">{vinculo.display_name}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={desligar.isPending}
              onClick={() => desligar.mutate()}
            >
              {t("Desligar deste card")}
            </Button>
          </div>
          <CartaoDoCliente organizationId={vinculo.organization_id} />
          <ConhecimentoDoCliente organizationId={vinculo.organization_id} />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="comercial-sem-vinculo">
          <p className="text-sm text-text-muted">
            {t("Este card ainda não está ligado a uma empresa-cliente. Escolha qual é para ver e controlar o comercial dela aqui.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("Empresa-cliente")}
              className="h-9 min-w-56 rounded-md border border-border bg-background px-2 text-sm"
              value={escolhida}
              onChange={(e) => setEscolhida(e.target.value)}
            >
              <option value="">{t("Escolha a empresa")}</option>
              {(data.empresas ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.display_name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={escolhida === "" || ligar.isPending}
              onClick={() => ligar.mutate(escolhida)}
            >
              {t("Ligar a este card")}
            </Button>
          </div>
        </div>
      )}
    </SecaoDoDossie>
  );
}

/**
 * O porteiro: só quem é a plataforma (e não está numa sessão de suporte) chega a
 * consultar o servidor. Os demais usuários nunca pagam a ida à rota nem montam a
 * consulta — e o servidor repete a mesma recusa, que é a que vale.
 */
export function ComercialDoCard(props: {
  leadId: string;
  recolhida: boolean;
  aoAlternar: (id: IdDeSecao) => void;
}) {
  const user = useUser();
  if (!user?.is_platform_admin || user.support) return null;
  return <ConteudoComercial {...props} />;
}

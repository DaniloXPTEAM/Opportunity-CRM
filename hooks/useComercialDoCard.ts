"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface ComercialDoCard {
  /** `false` = o card não tem a aba (não é do funil de clientes da plataforma, ou quem vê não é a plataforma). */
  habilitado: boolean;
  vinculo?: { organization_id: string; display_name: string } | null;
  empresas?: Array<{ id: string; display_name: string }>;
}

const chave = (leadId: string) => ["comercial", "card", leadId] as const;
const rota = (leadId: string) => `/api/v1/comercial/leads/${leadId}`;

export function useComercialDoCard(leadId: string) {
  return useQuery({
    queryKey: chave(leadId),
    queryFn: async () => (await apiClient.get<{ data: ComercialDoCard }>(rota(leadId))).data,
    // Quase todo card NÃO tem a aba: a resposta "habilitado: false" não muda sozinha.
    staleTime: 60_000,
  });
}

export function useLigacaoDoCard(leadId: string) {
  const qc = useQueryClient();
  const aoTerminar = () => {
    void qc.invalidateQueries({ queryKey: chave(leadId) });
    void qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  };
  return {
    ligar: useMutation({
      mutationFn: (organization_id: string) => apiClient.put(rota(leadId), { organization_id }),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
    desligar: useMutation({
      mutationFn: () => apiClient.delete(rota(leadId)),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
  };
}

/**
 * Busca o ai_agent configurado como agente de VOZ pra uma org
 * (ai_agents.channel = 'voice', coluna aditiva da migration 0347).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_CONFIG_DEFAULTS, agentConfigSchema } from "@/lib/ai/guardrails-schema";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

export interface VoiceAgentConfig {
  id: string;
  systemPrompt: string;
  /** Voz e velocidade da fala (session.audio.output) e parâmetros de RAG —
   *  configuráveis por Configurações > Agente > aba Voz, com fallback pros
   *  defaults quando a organização nunca mexeu nisso. */
  voice: string;
  voiceSpeed: number;
  ragTopK: number;
  ragSimilarityThreshold: number;
  voiceModel: string;
  /** `config.agenda_na_ligacao`: a ligação recebe as ferramentas de agenda. Desligado de fábrica. */
  agendaNaLigacao: boolean;
  /**
   * Chave da OpenAI pra abrir a sessão Realtime (WebSocket cru, não passa
   * pelo AI Gateway). Vem, em ordem: credencial cadastrada em IA >
   * Credenciais pra esta org, ou env OPENAI_API_KEY do servidor.
   */
  apiKey: string;
  /** Serviço de voz em tempo real que atende a ligação — ver `resolverMotorDeVoz`. */
  motor: "openai" | "gemini";
}

/**
 * A chave OpenAI ativa e validada desta org, cadastrada em IA > Credenciais --
 * mesma tabela/decrypt que o resto do produto usa (ver lib/ai/embeddings/chave.ts,
 * que resolve o mesmo tipo de chave pra embeddings). Sem credencial de org, cai
 * na chave do .env do servidor -- nunca deixa a ligação sem chave nenhuma.
 *
 * Desempate determinístico pela mais antiga (não "a mais recente"): com duas
 * chaves cadastradas e nenhuma escolha explícita, variar sozinho no dia em que
 * alguém cadastra uma segunda é pior que sempre usar a mesma.
 */
async function resolverChaveDoProvedor(organizationId: string, provider: "openai" | "google"): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", provider)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (data) {
      return decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      });
    }
  } catch {
    // Decrypt falhou ou a query deu erro -- cai pro .env abaixo, log já
    // aconteceu no INFO deste arquivo se aplicável; não vale a pena arriscar
    // ecoar detalhe de credencial no log do worker.
  }
  return provider === "openai" ? (process.env.OPENAI_API_KEY ?? "") : "";
}

/**
 * QUAL SERVIÇO DE VOZ ATENDE A LIGAÇÃO (e com que chave).
 *
 * Regra do produto: 100% gratuito. A OpenAI Realtime é paga, então só é usada
 * quando alguém JÁ cadastrou uma chave OpenAI (ou pôs OPENAI_API_KEY no servidor)
 * — quem tem, continua exatamente como era. Sem ela, a voz vai para o Gemini
 * Live com a mesma chave Google com que a Ruby já escreve (ver
 * `workers/voice-agent/geminiLive.ts`). Sem nenhuma das duas, a chave vem vazia e
 * a ligação falha na abertura, como antes.
 */
async function resolverMotorDeVoz(organizationId: string): Promise<{ motor: "openai" | "gemini"; apiKey: string }> {
  const openai = await resolverChaveDoProvedor(organizationId, "openai");
  if (openai) return { motor: "openai", apiKey: openai };
  const google = await resolverChaveDoProvedor(organizationId, "google");
  if (google) return { motor: "gemini", apiKey: google };
  return { motor: "openai", apiKey: "" };
}

export async function getActiveVoiceAgent(organizationId: string): Promise<VoiceAgentConfig | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select("id, system_prompt, config")
    .eq("organization_id", organizationId)
    .eq("channel", "voice")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const cfgParsed = agentConfigSchema.safeParse({
    ...AGENT_CONFIG_DEFAULTS,
    ...((data.config ?? {}) as Record<string, unknown>),
  });
  const cfg = cfgParsed.success ? cfgParsed.data : AGENT_CONFIG_DEFAULTS;

  const { motor, apiKey } = await resolverMotorDeVoz(organizationId);
  return {
    id: data.id,
    systemPrompt: data.system_prompt,
    voice: cfg.voice,
    voiceSpeed: cfg.voice_speed,
    voiceModel: cfg.voice_model,
    agendaNaLigacao: cfg.agenda_na_ligacao,
    ragTopK: cfg.rag_top_k,
    ragSimilarityThreshold: cfg.rag_similarity_threshold,
    apiKey,
    motor,
  };
}

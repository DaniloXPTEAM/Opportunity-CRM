/**
 * workers/voice-agent/geminiLive.ts
 *
 * O MOTOR DE VOZ GRATUITO: a Gemini Live API no lugar da OpenAI Realtime.
 *
 * ═══ POR QUE ═══
 *
 * A ponte (`audioSocketBridge.ts`) só falava com `wss://api.openai.com/v1/realtime`,
 * que é pago e exige chave OpenAI. O produto é 100% gratuito: a Ruby já fala e
 * escreve pelo Gemini com a chave Google da organização, e a Live API é o
 * equivalente em tempo real (ouve e fala direto, sem passar por texto).
 * Medido em 17/11/2026 com a chave da Ruby: 1º áudio em ~1,4 s (gemini-3.8-live),
 * 3 sessões simultâneas aceitas, em português.
 *
 * ═══ O QUE ESTE ARQUIVO É ═══
 *
 * Só funções PURAS (sem rede, sem relógio): montar a mensagem de abertura,
 * converter o áudio entre o telefone (PCM16 8 kHz) e o Gemini (PCM16 16 kHz
 * entrando, 24 kHz saindo) e traduzir as mensagens do servidor para eventos
 * simples. A ponte continua dona do socket, da fila de saída e da agenda — este
 * arquivo não conhece nada disso.
 *
 * ⚠️ O QUE NÃO É: o formato OpenAI. Aqui não existe `session.update`,
 * `response.create` nem `function_call_output`: o Gemini abre com `setup`,
 * recebe texto/áudio em `realtimeInput`, devolve ferramenta em `toolResponse`
 * e continua falando sozinho depois dela.
 */

/** Modelo padrão. Sobrescrevível por `GEMINI_LIVE_MODEL` (vazio conta como ausente). */
export const MODELO_GEMINI_LIVE_PADRAO = "gemini-3.8-live";

/** A mesma voz da resposta em áudio do WhatsApp (`resposta-em-audio.ts`). */
export const VOZ_GEMINI_PADRAO = "Kore";

export const TAXA_ENTRADA_GEMINI = 16000;
export const TAXA_SAIDA_GEMINI = 24000;

export function modeloGeminiLive(env: string | undefined = process.env.GEMINI_LIVE_MODEL): string {
  const v = env?.trim();
  return v ? v : MODELO_GEMINI_LIVE_PADRAO;
}

export function urlGeminiLive(): string {
  return "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
}

/**
 * ⚠️ A API do Google só aceita a chave no endereço da conexão (`?key=`) ou no
 * cabeçalho `x-goog-api-key`. Usamos o CABEÇALHO: chave em query string vaza em
 * log de proxy — é a regra da casa, mesmo sendo uma API de fora.
 */
export function cabecalhosGeminiLive(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

/** Uma ferramenta no formato da OpenAI Realtime (`type: "function"`) — é o que a ponte já declara. */
export interface FerramentaOpenAi {
  type: "function";
  name: string;
  description: string;
  parameters?: { type?: string; properties?: Record<string, unknown>; required?: readonly string[] };
}

/**
 * As ferramentas da ponte, no formato do Gemini. Sem parâmetros, o campo
 * `parameters` é OMITIDO (o Gemini recusa objeto vazio com `required: []`).
 */
export function ferramentasParaGemini(ferramentas: readonly FerramentaOpenAi[]): Array<{
  functionDeclarations: Array<{ name: string; description: string; parameters?: unknown }>;
}> {
  if (ferramentas.length === 0) return [];
  return [
    {
      functionDeclarations: ferramentas.map((f) => {
        const props = f.parameters?.properties ?? {};
        const temParametros = Object.keys(props).length > 0;
        return {
          name: f.name,
          description: f.description,
          ...(temParametros
            ? {
                parameters: {
                  type: "OBJECT",
                  properties: Object.fromEntries(
                    Object.entries(props).map(([nome, def]) => [nome, tipoParaGemini(def)]),
                  ),
                  ...(f.parameters?.required && f.parameters.required.length > 0
                    ? { required: [...f.parameters.required] }
                    : {}),
                },
              }
            : {}),
        };
      }),
    },
  ];
}

/** `string` → `STRING`, `integer` → `INTEGER`... (o Gemini escreve o tipo em maiúsculas). */
function tipoParaGemini(def: unknown): unknown {
  if (def === null || typeof def !== "object") return def;
  const d = { ...(def as Record<string, unknown>) };
  if (typeof d.type === "string") d.type = d.type.toUpperCase();
  return d;
}

export interface EntradaDoSetup {
  modelo: string;
  instrucoes: string;
  voz: string;
  ferramentas: readonly FerramentaOpenAi[];
}

/** A primeira mensagem da sessão. Transcrição ligada nos dois sentidos: o CRM grava a conversa. */
export function montarSetupGemini(e: EntradaDoSetup): Record<string, unknown> {
  const tools = ferramentasParaGemini(e.ferramentas);
  return {
    setup: {
      model: `models/${e.modelo}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: e.voz } } },
      },
      systemInstruction: { parts: [{ text: e.instrucoes }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(tools.length > 0 ? { tools } : {}),
    },
  };
}

/** Áudio do cliente (PCM16 LE a 16 kHz) → mensagem. */
export function mensagemDeAudio(pcm16k: Buffer): Record<string, unknown> {
  return {
    realtimeInput: { audio: { data: pcm16k.toString("base64"), mimeType: `audio/pcm;rate=${TAXA_ENTRADA_GEMINI}` } },
  };
}

/** Texto que entra como turno do cliente (usado para a IA abrir a ligação recebida). */
export function mensagemDeTexto(texto: string): Record<string, unknown> {
  return { realtimeInput: { text: texto } };
}

/** Resposta de uma ferramenta. O Gemini continua falando sozinho depois dela. */
export function respostaDeFerramenta(id: string, nome: string, saida: string): Record<string, unknown> {
  return { toolResponse: { functionResponses: [{ id, name: nome, response: { output: saida } }] } };
}

// ── Áudio ────────────────────────────────────────────────────────────────────

/** PCM16 LE a 8 kHz (telefone) → 16 kHz (Gemini), por interpolação linear. */
export function pcm8kPara16k(pcm8k: Buffer): Buffer {
  const n = Math.floor(pcm8k.length / 2);
  if (n === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const atual = pcm8k.readInt16LE(i * 2);
    const proximo = i + 1 < n ? pcm8k.readInt16LE((i + 1) * 2) : atual;
    out.writeInt16LE(atual, i * 4);
    out.writeInt16LE(Math.round((atual + proximo) / 2), i * 4 + 2);
  }
  return out;
}

/**
 * PCM16 LE a 24 kHz (Gemini) → 8 kHz (telefone): média de cada grupo de 3
 * amostras. A média age como filtro simples antes de descartar — sem ela a voz
 * ganha chiado (aliasing) de quem pula amostra.
 */
export function pcm24kPara8k(pcm24k: Buffer): Buffer {
  const n = Math.floor(pcm24k.length / 6);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const a = pcm24k.readInt16LE(i * 6);
    const b = pcm24k.readInt16LE(i * 6 + 2);
    const c = pcm24k.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return out;
}

/** Energia (RMS) de um trecho de PCM16 LE — 0 a 32768. */
export function energiaPcm16(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let soma = 0;
  for (let i = 0; i < n; i += 1) {
    const s = pcm.readInt16LE(i * 2);
    soma += s * s;
  }
  return Math.sqrt(soma / n);
}

/**
 * Detector de fala do CLIENTE para a regra "a pessoa respondeu ao resumo antes
 * de confirmar o agendamento".
 *
 * O Gemini não avisa "o cliente terminou o turno" como a OpenAI
 * (`input_audio_buffer.committed`), e a transcrição chega depois — pode vir
 * DEPOIS da chamada da ferramenta. Então a conta é feita aqui, pela energia do
 * áudio que o Asterisk entrega: acumula tempo de fala e, quando o modelo começa
 * a responder, fecha o turno se houve fala suficiente.
 */
export class DetectorDeFalaDoCliente {
  private msDeFala = 0;
  constructor(
    private readonly limiarDeEnergia = 400,
    private readonly msMinimo = 400,
  ) {}

  /** Chamado a cada trecho de áudio do cliente (`ms` = duração do trecho). */
  ouvir(pcm8k: Buffer, ms: number): void {
    if (energiaPcm16(pcm8k) >= this.limiarDeEnergia) this.msDeFala += ms;
  }

  /** O modelo começou a responder: se a pessoa falou o bastante, é um turno do cliente. */
  fecharTurno(): boolean {
    const falou = this.msDeFala >= this.msMinimo;
    this.msDeFala = 0;
    return falou;
  }
}

// ── Mensagens do servidor ───────────────────────────────────────────────────

export type EventoGemini =
  | { tipo: "pronto" }
  | { tipo: "audio"; pcm24k: Buffer }
  | { tipo: "fala_do_cliente"; texto: string }
  | { tipo: "fala_do_agente"; texto: string }
  | { tipo: "interrompido" }
  | { tipo: "turno_completo" }
  | { tipo: "ferramenta"; id: string; nome: string; args: Record<string, unknown> }
  | { tipo: "uso"; entrada: number; saida: number }
  | { tipo: "aviso_de_fim" };

/** O que lemos de uma mensagem do Google — tudo opcional: campo que não conhecemos é ignorado. */
interface MensagemDoServidor {
  setupComplete?: unknown;
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: { parts?: unknown };
    inputTranscription?: { text?: unknown };
    outputTranscription?: { text?: unknown };
  };
  toolCall?: { functionCalls?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; responseTokenCount?: unknown; candidatesTokenCount?: unknown };
  goAway?: unknown;
}

/**
 * Uma mensagem do servidor → zero ou mais eventos. NUNCA lança: mensagem que
 * não entendemos é descartada (o produto não pode cair por um campo novo do
 * Google).
 */
export function lerMensagemGemini(bruta: string | Buffer): EventoGemini[] {
  let m: MensagemDoServidor | null;
  try {
    m = JSON.parse(typeof bruta === "string" ? bruta : bruta.toString("utf8")) as MensagemDoServidor | null;
  } catch {
    return [];
  }
  if (m === null || typeof m !== "object") return [];

  const eventos: EventoGemini[] = [];
  if (m.setupComplete !== undefined) eventos.push({ tipo: "pronto" });

  const sc = m.serverContent;
  if (sc && typeof sc === "object") {
    if (sc.interrupted === true) eventos.push({ tipo: "interrompido" });
    const partes: unknown[] = Array.isArray(sc.modelTurn?.parts) ? sc.modelTurn.parts : [];
    for (const p of partes as Array<{ inlineData?: { data?: string } }>) {
      const dado = p?.inlineData?.data;
      if (typeof dado === "string" && dado.length > 0) eventos.push({ tipo: "audio", pcm24k: Buffer.from(dado, "base64") });
    }
    const dito = sc.inputTranscription?.text;
    if (typeof dito === "string" && dito !== "") eventos.push({ tipo: "fala_do_cliente", texto: dito });
    const falado = sc.outputTranscription?.text;
    if (typeof falado === "string" && falado !== "") eventos.push({ tipo: "fala_do_agente", texto: falado });
    if (sc.turnComplete === true) eventos.push({ tipo: "turno_completo" });
  }

  const chamadas: unknown[] = Array.isArray(m.toolCall?.functionCalls) ? m.toolCall.functionCalls : [];
  for (const c of chamadas as Array<{ id?: unknown; name?: unknown; args?: unknown }>) {
    if (typeof c?.name !== "string") continue;
    const args = c.args !== null && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {};
    eventos.push({ tipo: "ferramenta", id: typeof c.id === "string" ? c.id : c.name, nome: c.name, args });
  }

  const u = m.usageMetadata;
  if (u && typeof u === "object") {
    eventos.push({
      tipo: "uso",
      entrada: Number(u.promptTokenCount) || 0,
      saida: Number(u.responseTokenCount ?? u.candidatesTokenCount) || 0,
    });
  }
  if (m.goAway !== undefined) eventos.push({ tipo: "aviso_de_fim" });
  return eventos;
}

/**
 * A transcrição do Gemini chega em PEDAÇOS. Junta os pedaços de cada lado e
 * entrega o turno inteiro quando ele fecha (turno completo ou interrupção) —
 * primeiro o que o cliente disse, depois o que o agente falou, que é a ordem em
 * que aconteceu.
 */
export class JuntaTranscricao {
  private cliente = "";
  private agente = "";

  clienteDisse(pedaco: string): void {
    this.cliente += pedaco;
  }
  agenteDisse(pedaco: string): void {
    this.agente += pedaco;
  }

  /** Esvazia e devolve os turnos prontos, na ordem. */
  fechar(): Array<{ speaker: "customer" | "agent"; text: string }> {
    const saida: Array<{ speaker: "customer" | "agent"; text: string }> = [];
    const c = this.cliente.trim();
    const a = this.agente.trim();
    if (c !== "") saida.push({ speaker: "customer", text: c });
    if (a !== "") saida.push({ speaker: "agent", text: a });
    this.cliente = "";
    this.agente = "";
    return saida;
  }
}

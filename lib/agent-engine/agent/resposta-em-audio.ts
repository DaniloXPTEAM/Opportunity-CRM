/**
 * RESPONDER EM ÁUDIO QUANDO O CLIENTE MANDA ÁUDIO.
 *
 * Regra comercial (dono, 06/11/2026): quem escreve texto recebe texto; quem manda
 * áudio recebe áudio. A voz vem do Gemini (modelo TTS) com a MESMA credencial Google
 * da organização que já conversa — nenhuma chave nova.
 *
 * Falha-macio: qualquer problema (organização sem Google, TTS fora, texto longo,
 * upload recusado) devolve `null` e o chamador manda o texto normal. O áudio é
 * melhoria de experiência; a resposta é o produto.
 *
 * O arquivo sai como WAV (PCM 24 kHz do Gemini embrulhado em cabeçalho). O WAHA
 * converte para nota de voz (`sendVoice` com `convert: true`, ver `lib/waha/media-send.ts`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveOrgLlmConfig, type LlmEdgeConfig } from '../edge/llm/credentials';

import type { PedidoDeCanal } from './pedido-de-audio';

/**
 * A resposta deste turno sai em ÁUDIO? Quem manda áudio recebe áudio (espelhar),
 * e quem PEDE por escrito ("manda em áudio") também — antes só valia o espelho, e
 * a pessoa que digitava o pedido recebia texto com a etiqueta interna `[audio]`.
 * "Prefiro texto" ganha de tudo: é a última instrução de canal da pessoa.
 */
export function decidirRespostaEmAudio(clienteMandouAudio: boolean, pedido: PedidoDeCanal): boolean {
  if (pedido === 'texto') return false;
  if (pedido === 'audio') return true;
  return clienteMandouAudio;
}

export const MODELO_DE_VOZ = 'gemini-2.5-flash-preview-tts';
export const VOZ_PADRAO = 'Kore';
/** Acima disto o áudio fica longo demais para uma conversa: vai texto. */
/**
 * QUANTO CABE EM ÁUDIO — medido em 17/11/2026 com a voz Kore: 443 caracteres = 30 s de fala e
 * 795 caracteres = 43,5 s (cerca de 15–18 caracteres por segundo).
 *
 * - até MAX_CHARS_PARA_AUDIO (~50 s) a resposta sai em UM áudio;
 * - acima disso ela é dividida em áudios de até MAX_CHARS_POR_AUDIO (~30 s), no limite de
 *   MAX_AUDIOS_POR_RESPOSTA — o que passar disso segue em texto, que é a saída de sempre.
 */
export const MAX_CHARS_PARA_AUDIO = 900;
export const MAX_CHARS_POR_AUDIO = 450;
export const MAX_AUDIOS_POR_RESPOSTA = 3;

/**
 * O bloco do prompt dos turnos que viram áudio pela síntese GRATUITA. É o do caminho pago
 * (`BLOCO_DA_RESPOSTA_FALADA`, ~20 s), com o teto de acordo com o que o áudio daqui aceita.
 */
export const BLOCO_DA_RESPOSTA_FALADA_GRATUITA =
  '## Esta resposta vai sair como NOTA DE VOZ\n' +
  'O cliente vai OUVIR o que você mandar com send_message: a voz é gerada a partir do seu texto. ' +
  'Escreva para ser ouvido, no idioma da conversa:\n' +
  '- no máximo uns 45 segundos de fala (cerca de 700 caracteres), numa única mensagem — se passar, o sistema divide em áudios menores;\n' +
  '- uma ideia por vez, com frases simples, como num áudio de WhatsApp;\n' +
  '- sem listas, tópicos, emojis, siglas nem símbolos; números e preços escritos como se falam;\n' +
  '- se fizer sentido, termine com UMA pergunta.\n' +
  'Link, endereço longo ou dado para copiar não cabem em áudio: se precisar mandar, mande por escrito.';
const BUCKET_DA_CONVERSA = 'whatsapp-media';
const SAMPLE_RATE = 24000;

const DIRECAO_DE_VOZ =
  'Fale em português do Brasil, com sotaque brasileiro natural, tom caloroso e descontraído, como uma pessoa real conversando no WhatsApp: ';

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Texto como será FALADO: sem marcação que a voz leria em voz alta. */
export function textoParaFala(texto: string): string {
  return texto
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** PCM 16 bits mono do Gemini → WAV (o WAHA converte para nota de voz). */
export function pcmParaWav(pcm: Buffer, sampleRate: number = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** A mensagem que abriu o turno foi um áudio? (recorte por org + conversa + id + inbound) */
export async function mensagemRecebidaFoiAudio(
  db: Pick<pg.Pool, 'query'>,
  input: { tenantId: string; conversationId: string; inboundMessageId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ type: string }>(
    `select type from messages
      where organization_id = $1 and conversation_id = $2 and id = $3 and direction = 'inbound'
      limit 1`,
    [input.tenantId, input.conversationId, input.inboundMessageId],
  );
  return rows[0]?.type === 'audio';
}

export async function sintetizarVoz(args: {
  apiKey: string;
  texto: string;
  voz?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<Buffer | null> {
  const f = args.fetchFn ?? fetch;
  const res = await f(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_DE_VOZ}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': args.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: DIRECAO_DE_VOZ + args.texto }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: args.voz ?? VOZ_PADRAO } } },
        },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 45_000),
    },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };
  const b64 = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  return b64 ? Buffer.from(b64, 'base64') : null;
}

export interface DepsDoAudio {
  pool: pg.Pool;
  llmCfg: LlmEdgeConfig;
  supabase: SupabaseClient;
  log: Log;
}

/**
 * Gera a voz do `texto` e guarda na pasta da conversa. Devolve o caminho para o
 * envio como mídia, ou `null` (e o chamador manda texto).
 */
export async function prepararRespostaEmAudio(
  deps: DepsDoAudio,
  args: { tenantId: string; conversationId: string; texto: string },
): Promise<{ storagePath: string; mime: string } | null> {
  try {
    const fala = textoParaFala(args.texto);
    if (fala === '' || fala.length > MAX_CHARS_PARA_AUDIO) return null;

    const org = await resolveOrgLlmConfig(deps.pool, deps.llmCfg, args.tenantId);
    if (org.provider !== 'google' || !org.apiKey) return null;

    const pcm = await sintetizarVoz({ apiKey: org.apiKey, texto: fala });
    if (pcm === null || pcm.length === 0) return null;

    const storagePath = `${args.tenantId}/${args.conversationId}/${randomUUID()}.wav`;
    const { error } = await deps.supabase.storage
      .from(BUCKET_DA_CONVERSA)
      .upload(storagePath, pcmParaWav(pcm), { contentType: 'audio/wav' });
    if (error) {
      deps.log.warn('áudio da resposta não guardado (segue em texto)', { detalhe: error.message.slice(0, 120) });
      return null;
    }
    return { storagePath, mime: 'audio/wav' };
  } catch (err) {
    deps.log.warn('não consegui gerar o áudio da resposta (segue em texto)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * Envia o áudio preparado e só dá o turno por entregue se o canal ACEITOU (`sent`,
 * `already_sent` ou `queued`). Qualquer outro desfecho devolve `null`, e quem chama
 * segue pelo texto em bolhas — a resposta em áudio é um extra, nunca a única saída.
 * Fica aqui, e não no turno, para o call site do `inbound-turn` seguir curto.
 */
export async function aceitarEnvioDeAudio<A, R extends { kind: string }>(
  preparado: A | null,
  enviar: (audio: A) => Promise<R>,
): Promise<R | null> {
  if (preparado === null) return null;
  const r = await enviar(preparado);
  return r.kind === 'sent' || r.kind === 'already_sent' || r.kind === 'queued' ? r : null;
}


/**
 * Divide a fala em áudios de até `MAX_CHARS_POR_AUDIO`, cortando em fim de frase (e, se uma frase
 * sozinha passa do teto, na vírgula ou no espaço mais próximo). Texto que cabe num áudio volta
 * inteiro; o que exigiria mais de `MAX_AUDIOS_POR_RESPOSTA` áudios volta `null` (segue em texto).
 */
export function dividirParaAudio(fala: string): string[] | null {
  const limpa = fala.trim();
  if (limpa === '') return null;
  if (limpa.length <= MAX_CHARS_PARA_AUDIO) return [limpa];

  const frases = limpa.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [limpa];
  const pedacos: string[] = [];
  for (const frase of frases) {
    let resto = frase.trim();
    while (resto.length > MAX_CHARS_POR_AUDIO) {
      const janela = resto.slice(0, MAX_CHARS_POR_AUDIO);
      const corte = Math.max(janela.lastIndexOf(', '), janela.lastIndexOf(' '));
      const ate = corte > MAX_CHARS_POR_AUDIO / 2 ? corte + 1 : MAX_CHARS_POR_AUDIO;
      pedacos.push(resto.slice(0, ate).trim());
      resto = resto.slice(ate).trim();
    }
    if (resto !== '') pedacos.push(resto);
  }

  const partes: string[] = [];
  let atual = '';
  for (const pedaco of pedacos) {
    if (atual === '') atual = pedaco;
    else if (atual.length + 1 + pedaco.length <= MAX_CHARS_POR_AUDIO) atual = `${atual} ${pedaco}`;
    else {
      partes.push(atual);
      atual = pedaco;
    }
  }
  if (atual !== '') partes.push(atual);
  return partes.length <= MAX_AUDIOS_POR_RESPOSTA ? partes : null;
}

/**
 * Como `prepararRespostaEmAudio`, mas devolve UM ou VÁRIOS áudios (resposta longa dividida). As
 * partes são sintetizadas AO MESMO TEMPO — a síntese leva ~17 s para 30 s de fala, e em fila a
 * resposta de 1 minuto levaria o dobro. Se qualquer parte falhar, devolve `null`: o texto inteiro
 * segue como sempre (nunca metade em áudio e metade perdida).
 */
export async function prepararRespostasEmAudio(
  deps: DepsDoAudio,
  args: { tenantId: string; conversationId: string; texto: string },
): Promise<Array<{ storagePath: string; mime: string }> | null> {
  try {
    const partes = dividirParaAudio(textoParaFala(args.texto));
    if (partes === null) return null;

    const org = await resolveOrgLlmConfig(deps.pool, deps.llmCfg, args.tenantId);
    if (org.provider !== 'google' || !org.apiKey) return null;

    const prontos = await Promise.all(
      partes.map(async (parte) => {
        const pcm = await sintetizarVoz({ apiKey: org.apiKey, texto: parte });
        if (pcm === null || pcm.length === 0) return null;
        const storagePath = `${args.tenantId}/${args.conversationId}/${randomUUID()}.wav`;
        const { error } = await deps.supabase.storage
          .from(BUCKET_DA_CONVERSA)
          .upload(storagePath, pcmParaWav(pcm), { contentType: 'audio/wav' });
        if (error) {
          deps.log.warn('áudio da resposta não guardado (segue em texto)', { detalhe: error.message.slice(0, 120) });
          return null;
        }
        return { storagePath, mime: 'audio/wav' };
      }),
    );
    return prontos.every((p) => p !== null) ? (prontos as Array<{ storagePath: string; mime: string }>) : null;
  } catch (err) {
    deps.log.warn('não consegui gerar o áudio da resposta (segue em texto)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * Envia os áudios em ordem. O PRIMEIRO precisa ser aceito pelo canal, senão devolve `null` e o
 * texto segue. Se um áudio seguinte falhar, o turno conta como entregue (o cliente já ouviu o
 * começo): reenviar tudo em texto repetiria o que ele acabou de ouvir.
 */
export async function aceitarEnvioDeAudios<A, R extends { kind: string }>(
  preparados: readonly A[] | null,
  enviar: (audio: A) => Promise<R>,
  pausaEntreAudios: () => Promise<void> = async () => {},
): Promise<R | null> {
  if (preparados === null || preparados.length === 0) return null;
  let ultimo: R | null = null;
  for (const [i, audio] of preparados.entries()) {
    if (i > 0) await pausaEntreAudios();
    const aceito = await aceitarEnvioDeAudio(audio, enviar);
    if (aceito === null) return ultimo;
    ultimo = aceito;
  }
  return ultimo;
}

/**
 * O MOTOR GRATUITO (Gemini Live) DENTRO DA PONTE DE ÁUDIO.
 *
 * `geminiLive.test.ts` prova as funções puras. Aqui se prova o ENCAIXE: a ponte,
 * com `ctx.motor = "gemini"`, fala o protocolo do Google (não o da OpenAI) e
 * mantém as regras que não podem mudar de motor.
 *
 * Os casos:
 * (a) abre com `setup` (nunca `session.update`), com a chave no CABEÇALHO e
 *     fora do endereço, e declara as ferramentas no formato do Gemini;
 * (b) o áudio do cliente que chega ANTES do `setupComplete` espera, e depois
 *     sai como PCM a 16 kHz;
 * (c) ligação recebida: a IA abre a conversa por texto, só depois de pronta;
 * (d) a resposta de uma ferramenta volta com id e nome, SEM `response.create`;
 * (e) agenda: confirmar sem a pessoa ter falado depois do resumo NÃO grava; com
 *     a fala dela, grava (a detecção é pela energia do áudio);
 * (f) `encerrar_chamada` não recebe resposta (o áudio pendente drena e desliga);
 * (g) a transcrição entrega o cliente ANTES do agente.
 *
 * SABOTAGEM:
 * - mandar `session.update` no motor Gemini derruba (a);
 * - colocar a chave no endereço derruba (a);
 * - liberar o áudio antes do `setupComplete` derruba (b);
 * - tirar `fecharTurno()` de `iniciarRespostaDoModelo` derruba (e);
 * - responder a `encerrar_chamada` derruba (f).
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  ws: null as (EventEmitter & { send: ReturnType<typeof vi.fn>; readyState: number }) | null,
  url: "",
  opcoes: null as { headers?: Record<string, string> } | null,
}));

// WebSocket de brinquedo: nenhum byte sai para o Google.
vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor(url: string, opcoes?: { headers?: Record<string, string> }) {
      super();
      fakes.ws = this as never;
      fakes.url = url;
      fakes.opcoes = opcoes ?? null;
    }
  }
  return { default: FakeWs };
});

import type { AgendaDaVoz, PreparoDaVoz } from "./agenda-da-voz";
import { AudioSocketCallBridge } from "./audioSocketBridge";

const CHAVE = "AQ.chave-secreta-de-teste";

function socketDeBrinquedo() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.setNoDelay = vi.fn();
  s.write = vi.fn();
  s.end = vi.fn();
  s.destroy = vi.fn();
  s.destroyed = false;
  return s;
}

function agendaFalsa() {
  return {
    listarTipos: vi.fn(async () => "Consulta inicial, 30 minutos."),
    horariosLivres: vi.fn(async () => "Tenho segunda às 14 horas."),
    listarCompromissos: vi.fn(async () => "Nenhum compromisso."),
    preparar: vi.fn(
      async (_args?: unknown): Promise<PreparoDaVoz> => ({
        operacao: "marcar",
        args: { event_type_slug: "consulta-inicial", starts_at: "2026-11-10T17:00:00.000Z" },
        resumo: "Consulta inicial, segunda-feira, às 14 horas.",
      }),
    ),
    executar: vi.fn(async () => "Pronto: marquei segunda-feira às 14 horas."),
  };
}

type Turno = { speaker: "agent" | "customer"; text: string };
let ponte: AudioSocketCallBridge | null = null;
let socket: ReturnType<typeof socketDeBrinquedo>;
let turnos: Turno[];
let terminou: ReturnType<typeof vi.fn>;

function abrir(extra: Record<string, unknown> = {}, agenda?: AgendaDaVoz) {
  socket = socketDeBrinquedo();
  turnos = [];
  terminou = vi.fn();
  ponte = new AudioSocketCallBridge(socket as never, {
    callId: "chamada-1",
    organizationId: "org-1",
    agentInstructions: "Você é a Ruby.",
    voice: "marin",
    voiceSpeed: 1,
    motor: "gemini",
    apiKey: CHAVE,
    onTranscriptTurn: (t: Turno) => turnos.push(t),
    onCallEnded: terminou as never,
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
    ...(agenda ? { agenda } : {}),
    ...extra,
  } as never);
}

/** Tudo que a ponte enviou ao Google, já como objeto. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mensagem é JSON livre; o teste só lê campos
function enviados(): Array<Record<string, any>> {
  return fakes.ws!.send.mock.calls.map((c) => JSON.parse(c[0] as string));
}

async function esperarSetup() {
  fakes.ws!.emit("open");
  await vi.waitFor(() => expect(enviados().some((m) => m.setup)).toBe(true));
}

function emitir(msg: unknown) {
  fakes.ws!.emit("message", JSON.stringify(msg));
}

/** Um frame de áudio do Asterisk (tipo 0x10 + tamanho + PCM16 8 kHz). `amplitude` 0 = silêncio. */
function frameDeAudio(amplitude: number) {
  const payload = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) payload.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  const cab = Buffer.from([0x10, payload.length >> 8, payload.length & 0xff]);
  socket.emit("data", Buffer.concat([cab, payload]));
}

/** A pessoa fala por ~500 ms (acima do mínimo do detector). */
function pessoaFala() {
  for (let i = 0; i < 25; i += 1) frameDeAudio(3000);
}

function respostasDeFerramenta(): Array<{ id: string; name: string; response: { output: string } }> {
  return enviados().flatMap((m) => m.toolResponse?.functionResponses ?? []);
}

beforeEach(() => {
  fakes.ws = null;
});
afterEach(() => {
  ponte?.close();
  ponte = null;
});

describe("abertura da sessão", () => {
  it("(a) abre com setup; chave no cabeçalho, fora do endereço; ferramentas no formato do Gemini", async () => {
    abrir({}, agendaFalsa() as unknown as AgendaDaVoz);
    await esperarSetup();

    expect(fakes.url).toContain("generativelanguage.googleapis.com");
    expect(fakes.url).not.toContain(CHAVE);
    expect(fakes.opcoes?.headers).toEqual({ "x-goog-api-key": CHAVE });

    const tipos = enviados().map((m) => Object.keys(m)[0]);
    expect(tipos).toEqual(["setup"]); // nada de session.update
    const setup = enviados()[0]!.setup;
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.systemInstruction.parts[0].text).toContain("Você é a Ruby.");
    const nomes = setup.tools[0].functionDeclarations.map((f: { name: string }) => f.name);
    expect(nomes).toEqual(
      expect.arrayContaining(["encerrar_chamada", "achar_horario_livre", "preparar_agendamento", "confirmar_agendamento"]),
    );
    // sem parâmetros → campo omitido (o Gemini recusa objeto vazio)
    expect(setup.tools[0].functionDeclarations.find((f: { name: string }) => f.name === "encerrar_chamada").parameters).toBeUndefined();
  });

  it("(b) áudio que chega antes do setupComplete espera; depois sai como PCM 16 kHz", async () => {
    abrir();
    await esperarSetup();
    frameDeAudio(1000);
    expect(enviados().some((m) => m.realtimeInput)).toBe(false);

    emitir({ setupComplete: {} });
    const audio = enviados().find((m) => m.realtimeInput?.audio);
    expect(audio).toBeDefined();
    expect(audio!.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    // 160 amostras de 8 kHz → 320 de 16 kHz → 640 bytes
    expect(Buffer.from(audio!.realtimeInput.audio.data, "base64").length).toBe(640);
  });

  it("(c) ligação recebida: a IA abre a conversa por texto, depois de pronta", async () => {
    abrir({ falaPrimeiro: true });
    await esperarSetup();
    expect(enviados().some((m) => m.realtimeInput?.text)).toBe(false);
    emitir({ setupComplete: {} });
    expect(enviados().some((m) => typeof m.realtimeInput?.text === "string")).toBe(true);
    expect(enviados()[0]!.setup.systemInstruction.parts[0].text).toContain("acabou de atender");
  });
});

describe("ferramentas", () => {
  it("(d) a resposta volta com id e nome, sem response.create", async () => {
    const agenda = agendaFalsa();
    abrir({}, agenda as unknown as AgendaDaVoz);
    await esperarSetup();
    emitir({ setupComplete: {} });
    emitir({ toolCall: { functionCalls: [{ id: "f1", name: "achar_horario_livre", args: { tipo: "consulta" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(1));

    const r = respostasDeFerramenta()[0]!;
    expect(r).toEqual({ id: "f1", name: "achar_horario_livre", response: { output: "Tenho segunda às 14 horas." } });
    expect(JSON.stringify(enviados())).not.toContain("response.create");
    expect(agenda.horariosLivres).toHaveBeenCalledWith({ tipo: "consulta" });
  });

  it("(e) confirmar sem a pessoa responder NÃO grava; depois da fala dela, grava", async () => {
    const agenda = agendaFalsa();
    abrir({}, agenda as unknown as AgendaDaVoz);
    await esperarSetup();
    emitir({ setupComplete: {} });

    pessoaFala(); // "quero marcar para segunda às 14"
    emitir({ toolCall: { functionCalls: [{ id: "p1", name: "preparar_agendamento", args: { tipo: "consulta", hora: "14:00" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(1));
    expect(respostasDeFerramenta()[0]!.response.output).toContain("prep-1");

    emitir({ serverContent: { turnComplete: true } }); // a IA terminou de ler o resumo

    // a pessoa NÃO respondeu ainda → recusa
    emitir({ toolCall: { functionCalls: [{ id: "c1", name: "confirmar_agendamento", args: { id: "prep-1" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(2));
    expect(respostasDeFerramenta()[1]!.response.output).toContain("ainda não respondeu");
    expect(agenda.executar).not.toHaveBeenCalled();

    emitir({ serverContent: { turnComplete: true } });

    // a pessoa responde "sim" → grava
    pessoaFala();
    emitir({ toolCall: { functionCalls: [{ id: "c2", name: "confirmar_agendamento", args: { id: "prep-1" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(3));
    expect(agenda.executar).toHaveBeenCalledTimes(1);
    expect(respostasDeFerramenta()[2]!.response.output).toContain("Pronto");
  });

  it("(e2) ruído de linha (silêncio) não conta como a pessoa ter falado", async () => {
    const agenda = agendaFalsa();
    abrir({}, agenda as unknown as AgendaDaVoz);
    await esperarSetup();
    emitir({ setupComplete: {} });

    pessoaFala();
    emitir({ toolCall: { functionCalls: [{ id: "p1", name: "preparar_agendamento", args: { tipo: "consulta", hora: "14:00" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(1));
    emitir({ serverContent: { turnComplete: true } });

    for (let i = 0; i < 40; i += 1) frameDeAudio(0); // 800 ms de linha muda
    emitir({ toolCall: { functionCalls: [{ id: "c1", name: "confirmar_agendamento", args: { id: "prep-1" } }] } });
    await vi.waitFor(() => expect(respostasDeFerramenta().length).toBe(2));
    expect(agenda.executar).not.toHaveBeenCalled();
  });

  it("(f) encerrar_chamada não recebe resposta: o áudio pendente drena e desliga", async () => {
    abrir();
    await esperarSetup();
    emitir({ setupComplete: {} });
    emitir({ toolCall: { functionCalls: [{ id: "e1", name: "encerrar_chamada", args: {} }] } });
    await vi.waitFor(() => expect(terminou).toHaveBeenCalled()); // o pacer (20 ms) fecha a ligação
    expect(respostasDeFerramenta()).toEqual([]);
  });
});

describe("transcrição", () => {
  it("(g) entrega o cliente ANTES do agente, só no fim do turno", async () => {
    abrir();
    await esperarSetup();
    emitir({ setupComplete: {} });
    emitir({ serverContent: { outputTranscription: { text: "Claro, " } } });
    emitir({ serverContent: { inputTranscription: { text: "quero marcar" } } });
    emitir({ serverContent: { outputTranscription: { text: "posso ajudar." } } });
    expect(turnos).toEqual([]); // ainda no meio do turno
    emitir({ serverContent: { turnComplete: true } });
    expect(turnos).toEqual([
      { speaker: "customer", text: "quero marcar" },
      { speaker: "agent", text: "Claro, posso ajudar." },
    ]);
  });

  it("(g2) o último turno não se perde quando a ligação cai no meio", async () => {
    abrir();
    await esperarSetup();
    emitir({ setupComplete: {} });
    emitir({ serverContent: { inputTranscription: { text: "tchau" } } });
    socket.emit("close"); // o Asterisk desligou
    expect(turnos).toEqual([{ speaker: "customer", text: "tchau" }]);
    expect(terminou).toHaveBeenCalledTimes(1);
  });
});

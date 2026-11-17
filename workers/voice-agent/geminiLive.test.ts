import { describe, expect, it } from "vitest";
import {
  DetectorDeFalaDoCliente,
  JuntaTranscricao,
  MODELO_GEMINI_LIVE_PADRAO,
  cabecalhosGeminiLive,
  energiaPcm16,
  ferramentasParaGemini,
  lerMensagemGemini,
  mensagemDeAudio,
  modeloGeminiLive,
  montarSetupGemini,
  pcm24kPara8k,
  pcm8kPara16k,
  respostaDeFerramenta,
  urlGeminiLive,
} from "./geminiLive";

function pcm(...amostras: number[]): Buffer {
  const b = Buffer.alloc(amostras.length * 2);
  amostras.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}
function amostras(b: Buffer): number[] {
  return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
}

describe("conexão", () => {
  it("a chave vai no CABEÇALHO, nunca no endereço", () => {
    expect(urlGeminiLive()).not.toMatch(/key=/i);
    expect(cabecalhosGeminiLive("AQ.segredo")).toEqual({ "x-goog-api-key": "AQ.segredo" });
  });

  it("modelo: vazio ou só espaço vale o padrão (o .env.example entrega variável vazia)", () => {
    expect(modeloGeminiLive("")).toBe(MODELO_GEMINI_LIVE_PADRAO);
    expect(modeloGeminiLive("   ")).toBe(MODELO_GEMINI_LIVE_PADRAO);
    expect(modeloGeminiLive(undefined)).toBe(MODELO_GEMINI_LIVE_PADRAO);
    expect(modeloGeminiLive(" gemini-3.1-flash-live-preview ")).toBe("gemini-3.1-flash-live-preview");
  });
});

describe("ferramentas", () => {
  it("sem parâmetros: o campo é omitido (o Gemini recusa objeto vazio)", () => {
    const [grupo] = ferramentasParaGemini([
      { type: "function", name: "encerrar_chamada", description: "x", parameters: { type: "object", properties: {}, required: [] } },
    ]);
    expect(grupo!.functionDeclarations[0]).toEqual({ name: "encerrar_chamada", description: "x" });
  });

  it("com parâmetros: tipos em maiúsculas e required preservado", () => {
    const [grupo] = ferramentasParaGemini([
      {
        type: "function",
        name: "achar_horario_livre",
        description: "x",
        parameters: {
          type: "object",
          properties: { tipo: { type: "string", description: "t" }, dias_a_frente: { type: "number" } },
          required: ["tipo"],
        },
      },
    ]);
    expect(grupo!.functionDeclarations[0]!.parameters).toEqual({
      type: "OBJECT",
      properties: { tipo: { type: "STRING", description: "t" }, dias_a_frente: { type: "NUMBER" } },
      required: ["tipo"],
    });
  });

  it("lista vazia não declara nada", () => {
    expect(ferramentasParaGemini([])).toEqual([]);
  });
});

describe("setup", () => {
  it("fala em áudio, com a voz pedida, transcrição nos dois sentidos e as instruções", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mensagem é JSON livre; o teste só lê campos
    const m = montarSetupGemini({ modelo: "gemini-3.8-live", instrucoes: "Você é a Ruby.", voz: "Kore", ferramentas: [] }) as any;
    expect(m.setup.model).toBe("models/gemini-3.8-live");
    expect(m.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(m.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(m.setup.systemInstruction.parts[0].text).toBe("Você é a Ruby.");
    expect(m.setup.inputAudioTranscription).toEqual({});
    expect(m.setup.outputAudioTranscription).toEqual({});
    expect(m.setup.tools).toBeUndefined();
  });
});

describe("mensagens que saem", () => {
  it("áudio do cliente: PCM a 16 kHz em base64", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mensagem é JSON livre; o teste só lê campos
    const m = mensagemDeAudio(pcm(1, 2)) as any;
    expect(m.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(m.realtimeInput.audio.data, "base64")).toEqual(pcm(1, 2));
  });

  it("resposta de ferramenta leva o id e o nome da chamada", () => {
    expect(respostaDeFerramenta("c1", "achar_horario_livre", "tem 10h")).toEqual({
      toolResponse: { functionResponses: [{ id: "c1", name: "achar_horario_livre", response: { output: "tem 10h" } }] },
    });
  });
});

describe("áudio", () => {
  it("8 kHz → 16 kHz dobra as amostras e interpola o meio", () => {
    expect(amostras(pcm8kPara16k(pcm(0, 100, 200)))).toEqual([0, 50, 100, 150, 200, 200]);
  });

  it("8 kHz → 16 kHz: vazio continua vazio", () => {
    expect(pcm8kPara16k(Buffer.alloc(0)).length).toBe(0);
  });

  it("24 kHz → 8 kHz: média de cada 3 amostras", () => {
    expect(amostras(pcm24kPara8k(pcm(3, 6, 9, 30, 60, 90)))).toEqual([6, 60]);
  });

  it("24 kHz → 8 kHz: sobra (menos de 3 amostras) é ignorada, não vira lixo", () => {
    expect(amostras(pcm24kPara8k(pcm(3, 6, 9, 1, 1)))).toEqual([6]);
  });

  it("energia: silêncio é 0 e sinal forte passa do limiar", () => {
    expect(energiaPcm16(pcm(0, 0, 0))).toBe(0);
    expect(energiaPcm16(pcm(1000, -1000, 1000))).toBe(1000);
  });
});

describe("detector de fala do cliente", () => {
  it("só conta turno se a pessoa falou o bastante antes de o modelo responder", () => {
    const d = new DetectorDeFalaDoCliente(400, 400);
    d.ouvir(pcm(0, 0, 0), 20); // silêncio
    expect(d.fecharTurno()).toBe(false);
    for (let i = 0; i < 25; i += 1) d.ouvir(pcm(2000, -2000), 20); // 500 ms de fala
    expect(d.fecharTurno()).toBe(true);
    expect(d.fecharTurno()).toBe(false); // zerou
  });
});

describe("mensagens que chegam", () => {
  it("setupComplete vira 'pronto'", () => {
    expect(lerMensagemGemini('{"setupComplete":{}}')).toEqual([{ tipo: "pronto" }]);
  });

  it("áudio do modelo vem em base64 (24 kHz)", () => {
    const dado = pcm(7, 8).toString("base64");
    const [ev] = lerMensagemGemini(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: dado } }] } } }));
    expect(ev).toEqual({ tipo: "audio", pcm24k: pcm(7, 8) });
  });

  it("transcrição dos dois lados, interrupção e fim de turno", () => {
    const evs = lerMensagemGemini(
      JSON.stringify({
        serverContent: {
          inputTranscription: { text: "oi" },
          outputTranscription: { text: "olá" },
          interrupted: true,
          turnComplete: true,
        },
      }),
    );
    expect(evs.map((e) => e.tipo)).toEqual(["interrompido", "fala_do_cliente", "fala_do_agente", "turno_completo"]);
  });

  it("chamada de ferramenta traz id, nome e argumentos já como objeto", () => {
    const evs = lerMensagemGemini(
      JSON.stringify({ toolCall: { functionCalls: [{ id: "f1", name: "consultar_conhecimento", args: { pergunta: "preço" } }] } }),
    );
    expect(evs).toEqual([{ tipo: "ferramenta", id: "f1", nome: "consultar_conhecimento", args: { pergunta: "preço" } }]);
  });

  it("ferramenta sem argumentos vira objeto vazio; sem nome é descartada", () => {
    expect(lerMensagemGemini(JSON.stringify({ toolCall: { functionCalls: [{ id: "f2", name: "encerrar_chamada" }] } }))).toEqual([
      { tipo: "ferramenta", id: "f2", nome: "encerrar_chamada", args: {} },
    ]);
    expect(lerMensagemGemini(JSON.stringify({ toolCall: { functionCalls: [{ id: "f3" }] } }))).toEqual([]);
  });

  it("NUNCA lança: lixo, texto vazio e formato novo viram lista vazia", () => {
    expect(lerMensagemGemini("não é json")).toEqual([]);
    expect(lerMensagemGemini("null")).toEqual([]);
    expect(lerMensagemGemini('{"campoNovoDoGoogle":1}')).toEqual([]);
  });

  it("aviso de fim de sessão e uso", () => {
    expect(lerMensagemGemini('{"goAway":{"timeLeft":"10s"}}')).toEqual([{ tipo: "aviso_de_fim" }]);
    expect(lerMensagemGemini('{"usageMetadata":{"promptTokenCount":10,"responseTokenCount":5}}')).toEqual([
      { tipo: "uso", entrada: 10, saida: 5 },
    ]);
  });
});

describe("junta transcrição", () => {
  it("junta os pedaços e entrega o cliente ANTES do agente", () => {
    const j = new JuntaTranscricao();
    j.agenteDisse("Claro, ");
    j.clienteDisse("quero ");
    j.clienteDisse("marcar");
    j.agenteDisse("posso ajudar.");
    expect(j.fechar()).toEqual([
      { speaker: "customer", text: "quero marcar" },
      { speaker: "agent", text: "Claro, posso ajudar." },
    ]);
    expect(j.fechar()).toEqual([]); // esvaziou
  });
});

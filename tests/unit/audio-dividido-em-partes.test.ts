/**
 * ÁUDIO LONGO: um áudio até ~50 s; acima disso, áudios de ~30 s (medido 17/11/2026: 443 caracteres =
 * 30 s e 795 = 43,5 s com a voz Kore). Antes o limite era 700 e a resposta grande caía em TEXTO.
 *
 * SABOTAGEM:
 * - voltar MAX_CHARS_PARA_AUDIO para 700 derruba "cabe em um áudio até ~50 s";
 * - cortar no meio da frase (ignorar o fim de frase) derruba "corta em fim de frase";
 * - deixar passar de MAX_AUDIOS_POR_RESPOSTA derruba "o que exigiria mais de 3 áudios segue em texto";
 * - reenviar tudo em texto quando o 2º áudio falha derruba "falha no 2º áudio".
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIOS_POR_RESPOSTA,
  MAX_CHARS_PARA_AUDIO,
  MAX_CHARS_POR_AUDIO,
  aceitarEnvioDeAudios,
  dividirParaAudio,
} from "@/lib/agent-engine/agent/resposta-em-audio";

const frase = "Esta é uma frase de exemplo para a conversa de teste da Ruby. ";
const texto = (chars: number) => frase.repeat(Math.ceil(chars / frase.length)).slice(0, chars).trim();

describe("dividirParaAudio", () => {
  it("cabe em um áudio até ~50 s (900 caracteres)", () => {
    expect(MAX_CHARS_PARA_AUDIO).toBe(900);
    const t = texto(880);
    expect(dividirParaAudio(t)).toEqual([t]);
  });

  it("acima disso divide em áudios de até ~30 s (450 caracteres)", () => {
    const partes = dividirParaAudio(texto(1000))!;
    expect(partes.length).toBe(3);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(MAX_CHARS_POR_AUDIO);
  });

  it("corta em fim de frase: nenhuma parte começa ou termina no meio de uma palavra", () => {
    const partes = dividirParaAudio(texto(1000))!;
    for (const p of partes.slice(0, -1)) expect(p).toMatch(/[.!?]$/);
    for (const p of partes) expect(p).toMatch(/^Esta é uma frase/);
  });

  it("não perde nenhuma palavra ao dividir", () => {
    const t = texto(1200);
    const partes = dividirParaAudio(t)!;
    expect(partes.join(" ").replace(/\s+/g, " ")).toBe(t.replace(/\s+/g, " "));
  });

  it("uma frase sozinha maior que o teto é cortada no espaço mais próximo", () => {
    const longa = ("palavra ".repeat(200)).trim(); // ~1.600 caracteres sem ponto
    const partes = dividirParaAudio(longa.slice(0, 1000))!;
    for (const p of partes) {
      expect(p.length).toBeLessThanOrEqual(MAX_CHARS_POR_AUDIO);
      expect(p).toMatch(/^(palavra )*palavra$/); // só palavras inteiras: nada cortado ao meio
    }
  });

  it("o que exigiria mais de 3 áudios segue em texto", () => {
    expect(MAX_AUDIOS_POR_RESPOSTA).toBe(3);
    expect(dividirParaAudio(texto(2000))).toBeNull();
  });

  it("vazio não vira áudio", () => {
    expect(dividirParaAudio("   ")).toBeNull();
  });
});

describe("aceitarEnvioDeAudios", () => {
  const ok = (n: number) => ({ kind: "sent" as const, n });

  it("envia todos em ordem, com pausa entre eles, e devolve o último aceito", async () => {
    const ordem: number[] = [];
    const pausa = vi.fn(async () => {});
    const r = await aceitarEnvioDeAudios([1, 2, 3], async (a) => (ordem.push(a), ok(a)), pausa);
    expect(ordem).toEqual([1, 2, 3]);
    expect(pausa).toHaveBeenCalledTimes(2);
    expect(r).toEqual(ok(3));
  });

  it("o 1º áudio recusado devolve null (o texto segue)", async () => {
    const r = await aceitarEnvioDeAudios([1, 2], async () => ({ kind: "failed" as const }));
    expect(r).toBeNull();
  });

  it("falha no 2º áudio: conta como entregue (não reenvia tudo em texto)", async () => {
    const r = await aceitarEnvioDeAudios([1, 2, 3], async (a) => (a === 2 ? { kind: "failed" as const } : ok(a)));
    expect(r).toEqual(ok(1));
  });

  it("sem áudios (null ou vazio) devolve null", async () => {
    expect(await aceitarEnvioDeAudios(null, async () => ok(0))).toBeNull();
    expect(await aceitarEnvioDeAudios([], async () => ok(0))).toBeNull();
  });
});

/**
 * Dois defeitos medidos numa conversa real (17/11/2026, WhatsApp):
 *  (1) a pessoa digitou "Manda em áudio" e a resposta saiu em TEXTO começando
 *      com a etiqueta interna "[audio]";
 *  (2) o espelho só olhava se a mensagem recebida era áudio.
 *
 * SABOTAGEM:
 * - tirar a troca do marcador derruba (1);
 * - fazer `decidirRespostaEmAudio` ignorar o pedido derruba (2).
 */
import { describe, expect, it } from "vitest";
import { tirarMarcadorDeMidia } from "@/lib/agent-engine/agent/marcador-de-midia";
import { decidirRespostaEmAudio } from "@/lib/agent-engine/agent/resposta-em-audio";
import { lerPedidoDeAudio } from "@/lib/agent-engine/agent/pedido-de-audio";

describe("tirarMarcadorDeMidia", () => {
  it("tira a etiqueta do começo do texto", () => {
    expect(tirarMarcadorDeMidia("[audio] Com certeza, Danilo!")).toBe("Com certeza, Danilo!");
    expect(tirarMarcadorDeMidia("[áudio]: Oi")).toBe("Oi");
    expect(tirarMarcadorDeMidia("[Audio]\nOi, tudo bem?")).toBe("Oi, tudo bem?");
  });
  it("tira de cada começo de linha", () => {
    expect(tirarMarcadorDeMidia("Oi!\n[image] veja isso")).toBe("Oi!\nveja isso");
  });
  it("não mexe em texto normal nem em colchete no meio da frase", () => {
    expect(tirarMarcadorDeMidia("Mando o [audio] depois")).toBe("Mando o [audio] depois");
    expect(tirarMarcadorDeMidia("Tudo certo por aqui")).toBe("Tudo certo por aqui");
  });
  it("se só sobrasse a etiqueta, devolve o original (não some com a mensagem)", () => {
    expect(tirarMarcadorDeMidia("[audio]")).toBe("[audio]");
  });
});

describe("decidirRespostaEmAudio", () => {
  it("espelha: quem mandou áudio recebe áudio", () => {
    expect(decidirRespostaEmAudio(true, "nenhum")).toBe(true);
    expect(decidirRespostaEmAudio(false, "nenhum")).toBe(false);
  });
  it("quem PEDE áudio por escrito recebe áudio", () => {
    expect(decidirRespostaEmAudio(false, lerPedidoDeAudio("Manda em áudio"))).toBe(true);
  });
  it("'prefiro texto' vence até do espelho", () => {
    expect(decidirRespostaEmAudio(true, lerPedidoDeAudio("prefiro texto"))).toBe(false);
  });
  it("assunto que cita áudio sem pedir não liga a voz", () => {
    expect(decidirRespostaEmAudio(false, lerPedidoDeAudio("grava áudio na sua clínica?"))).toBe(false);
  });
});

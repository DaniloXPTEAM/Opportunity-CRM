/**
 * O MARCADOR DE MÍDIA NUNCA SAI NO TEXTO PARA O CLIENTE.
 *
 * O histórico que o modelo lê marca mensagem de mídia sem texto como `[audio]`,
 * `[image]`... (`corpoDaMensagem`, em `edge/crm/get-lead-context.ts`). O modelo
 * imita o que vê: pedido de "manda em áudio" com a resposta saindo em TEXTO virou
 * "[audio] Com certeza, ..." — a pessoa lia a etiqueta interna no WhatsApp.
 *
 * Isto tira a etiqueta do INÍCIO do texto (e do começo de linha). Só os nomes do
 * vocabulário do banco; "[audio]" no meio de uma frase explicada não é tocado.
 * Se o texto fosse SÓ a etiqueta, devolve o original: sumir com a mensagem seria
 * pior que mostrá-la.
 */
const MARCADOR = /^[ \t]*\[(?:audio|áudio|image|imagem|video|vídeo|document|documento|sticker|figurinha)\][ \t:,.\-–—]*/gim;

export function tirarMarcadorDeMidia(texto: string): string {
  const limpo = texto.replace(MARCADOR, "").trim();
  return limpo === "" ? texto : limpo;
}

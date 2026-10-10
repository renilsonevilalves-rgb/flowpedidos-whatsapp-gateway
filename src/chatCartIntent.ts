// src/chatCartIntent.ts
import { normalizedText, type CatalogEntry } from "./chatDialogue.js";

type CartLine = { productId: string; quantity: number };
export type CartAction =
  | { kind: "remove"; productId: string; quantity: number | null }
  | { kind: "status"; productId: string }
  | { kind: "clarify"; operation: "remove" | "status"; choices: string[] };

function mentionsProduct(text: string, productName: string): boolean {
  const name = normalizedText(productName);
  const parts = name.split(" ");
  const plural = parts.map((word, index) => {
    if (index !== parts.length - 1 || word.length < 4) return word;
    return word.endsWith("m") ? word.slice(0, -1) + "ns" : word + "s";
  }).join(" ");
  const padded = " " + text + " ";
  return padded.includes(" " + name + " ") || padded.includes(" " + plural + " ");
}

function requestedRemovalQuantity(text: string): number | null {
  const match = text.match(/\b(?:tira|tire|tirar|retira|retire|retirar|remove|remova|remover|exclui|exclua|excluir|apaga|apague|apagar)\s+(?:(?:o|a|os|as|so|apenas|mais)\s+)?(\d{1,3}|um|uma|dois|duas|tres|quatro|cinco)\b/);
  if (!match) return null;
  const number = Number(match[1]);
  if (Number.isInteger(number) && number > 0) return number;
  return ({ um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 } as Record<string, number>)[match[1]] || null;
}

export function resolveCartAction(
  input: string,
  products: CatalogEntry[],
  lines: CartLine[],
): CartAction | null {
  const text = normalizedText(input);
  if (!text) return null;

  const status = /\b(?:retirou|tirou|removeu|excluiu|apagou|conseguiu tirar|conseguiu retirar|ja tirou|ja retirou|foi retirado|foi removido)\b/.test(text) ||
    /\b(?:ainda tem|continua|esta|ta)\b.*\b(?:no carrinho|no pedido)\b/.test(text);
  const removal = /\b(?:tira|tire|tirar|retira|retire|retirar|remove|remova|remover|exclui|exclua|excluir|apaga|apague|apagar|nao quero mais|nao quero)\b/.test(text) ||
    /\b(?:quero|deixa|faz|faca)\b.*\bsem\s+(?:o|a|os|as)\b/.test(text);
  if (!status && !removal) return null;
  if (!status && /\b(?:nao quero|nao precisa)\s+(?:que\s+)?(?:tirar|tire|retirar|retire|remover|remova)\b/.test(text)) return null;
  // Conditional questions must not perform a real cart mutation.
  if (!status && /\b(?:se eu|e se|se a gente|quanto ficaria|quanto fica se|quanto sai se)\b/.test(text))
    return { kind: "clarify", operation: "remove", choices: [] };
  const operation: "status" | "remove" = status ? "status" : "remove";

  // Do not silently execute half of a request containing multiple types of cart edits.
  if (operation === "remove" && /\b(?:adiciona|adicionar|acrescenta|acrescentar|inclui|incluir|coloca|colocar|troca|trocar|substitui|substituir)\b/.test(text))
    return { kind: "clarify", operation, choices: [] };

  const mentioned = products.filter(product => mentionsProduct(text, product.name));
  const candidates = mentioned.length ? mentioned :
    /\b(?:ele|ela|esse|essa|aquele|aquela)\b/.test(text)
      ? products.filter(product => lines.some(line => line.productId === product.id))
      : [];
  if (candidates.length !== 1) {
    return { kind: "clarify", operation, choices: candidates.slice(0, 5).map(p => p.name) };
  }
  const productId = candidates[0].id;
  return operation === "status" ? { kind: "status", productId } :
    { kind: "remove", productId, quantity: requestedRemovalQuantity(text) };
}

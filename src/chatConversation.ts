// src/chatConversation.ts
import { normalizedText } from "./chatDialogue.js";

export type KnownProduct = {
  id: string;
  name: string;
  category?: string;
  price: number;
  promotionEnabled?: boolean;
  originalPrice?: number | null;
};

export type ChoiceTopic = "refrigerante" | "bebida" | "suco" | "sobremesa";
export type OpenChoice = { topic: ChoiceTopic; options: KnownProduct[] };

const contains = (text: string, expression: RegExp) => expression.test(text);

export function isPromotionQuestion(input: string): boolean {
  const text = normalizedText(input);
  return contains(text, /\b(?:promocao|promocoes|promocional|oferta|ofertas|desconto|descontos)\b/) &&
    !contains(text, /\b(?:quero|vou|pedir|adiciona|adicionar|tira|tirar|remove|remover)\b.*\b(?:a promocao|a oferta)\b/);
}

export function promotionScope(input: string): "lanche" | "bebida" | "sobremesa" | "geral" {
  const text = normalizedText(input);
  if (/\b(?:lanche|lanches|hamburguer|hamburgueres|burger|burgers|sanduiche|sanduiches)\b/.test(text)) return "lanche";
  if (/\b(?:bebida|bebidas|refri|refrigerante|refrigerantes|sucos|suco)\b/.test(text)) return "bebida";
  if (/\b(?:sobremesa|sobremesas|doce|doces|pudim|sorvete)\b/.test(text)) return "sobremesa";
  return "geral";
}

function matchesScope(product: KnownProduct, scope: ReturnType<typeof promotionScope>): boolean {
  if (scope === "geral") return true;
  const category = normalizedText(product.category || "");
  const name = normalizedText(product.name);
  const combined = category + " " + name;
  if (scope === "lanche") return /\b(?:lanche|lanches|hamburguer|hamburgueres|burger|burgers|sanduiche|sanduiches|x\s*tudo|x\s*egg|combo)\b/.test(combined);
  if (scope === "bebida") return /\b(?:bebida|bebidas|refrigerante|refrigerantes|sucos|suco|agua|coca|fanta|pepsi|sprite|guarana)\b/.test(combined);
  return /\b(?:sobremesa|sobremesas|doce|doces|pudim|bolo|sorvete|acai)\b/.test(combined);
}

export function promotionsFor(input: string, catalog: KnownProduct[]): KnownProduct[] {
  const scope = promotionScope(input);
  return catalog.filter(product =>
    product.promotionEnabled === true &&
    Number.isFinite(Number(product.originalPrice)) &&
    Number(product.originalPrice) > product.price &&
    Number.isFinite(product.price) && product.price >= 0 &&
    matchesScope(product, scope)
  );
}

export function scopeLabel(input: string): string {
  const scope = promotionScope(input);
  return scope === "lanche" ? "lanche" : scope === "bebida" ? "bebida" :
    scope === "sobremesa" ? "sobremesa" : "produto";
}

function matchesChoice(product: KnownProduct, topic: ChoiceTopic): boolean {
  const category = normalizedText(product.category || "");
  const name = normalizedText(product.name);
  if (topic === "refrigerante") {
    return /\b(?:refrigerante|refrigerantes)\b/.test(category) ||
      /\b(?:coca(?: cola)?|pepsi|fanta|guarana|sprite|soda|schweppes)\b/.test(name);
  }
  if (topic === "bebida") return matchesScope(product, "bebida");
  if (topic === "suco") return /\b(?:suco|sucos)\b/.test(category + " " + name) ||
    /\b(?:dell vale|del valle|del vale)\b/.test(name);
  return matchesScope(product, "sobremesa");
}

export function unresolvedChoice(
  input: string,
  catalog: KnownProduct[],
  acceptedProductIds: string[],
): OpenChoice | null {
  const text = normalizedText(input);
  // Only intercept a generic product explicitly requested for this order.
  // Questions about availability or prices are handled by the catalog dialogue.
  if (!/\b(?:quero|queria|vou querer|me ve|coloca|adiciona|pedido|\d+x?|um|uma|dois|duas|tres)\b/.test(text) ||
      /^(?:qual|quais|tem|vende|quanto|preco|valor)\b/.test(text)) return null;
  const topic: ChoiceTopic | undefined =
    /\b(?:refrigerante|refrigerantes|refri|refris)\b/.test(text) ? "refrigerante" :
    /\b(?:suco|sucos)\b/.test(text) ? "suco" :
    /\b(?:bebida|bebidas)\b/.test(text) ? "bebida" :
    /\b(?:sobremesa|sobremesas)\b/.test(text) ? "sobremesa" : undefined;
  if (!topic) return null;
  const options = catalog.filter(product => matchesChoice(product, topic));
  if (!options.length) return null;

  // A precisely named option is not an unresolved generic request.
  const specific = options.some(p => {
    const name = normalizedText(p.name);
    return name.length > 3 && (" " + text + " ").includes(" " + name + " ");
  });
  if (specific) return null;
  // Model selection based only on "refrigerante" is not permission to choose a size.
  // Caller must remove any guessed category product from the interpreted draft.
  return { topic, options };
}

export function formatOptions(products: KnownProduct[], money: (price: number) => string, limit = 5): string {
  return products.slice(0, limit).map(product => "*" + product.name + "* (" + money(product.price) + ")").join(", ") +
    (products.length > limit ? " e outras opções" : "");
}

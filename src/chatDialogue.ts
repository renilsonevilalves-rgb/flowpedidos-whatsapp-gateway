// src/chatDialogue.ts
// Pure, deterministic catalog question parsing. No model-generated product or pricing facts.
export type CatalogEntry = {
  id: string; name: string; price: number;
  optionGroups?: Array<{ name: string; options: Array<{ name: string }> }>;
};
export type Inquiry = { type: "availability" | "price" | "followup"; query: string };
export function normalizedText(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function trimNaturalModifiers(value: string): string {
  return value
    .replace(/\b(?:se tiver|se tem|se sim|quero trocar|pode trocar|gostaria de trocar|quero adicionar|quero acrescentar|queria pedir|pra mim|para mim)\b.*$/, "")
    .replace(/(?:\s+(?:tambem|ainda|ai|hoje|agora|por favor|disponivel|no cardapio|na loja))+$/g, "")
    .replace(/^(?:de|do|da|com|o|a|um|uma|algum|alguma|opcao de|lanche de|produto de)\s+/, "")
    .replace(/\s+/g, " ").trim();
}
export function readInquiry(input: string, previous?: string): Inquiry | null {
  const text = normalizedText(input);
  if (!text) return null;
  if (/^(?:nao tem|nao tem mesmo|mas nao tem|tem certeza|tem mesmo|tem ai mesmo|voce tem certeza|serio que nao tem)$/.test(text))
    return previous ? { type: "followup", query: previous } : null;

  const price = text.match(/(?:quanto custa|qual (?:o )?(?:preco|valor)|quanto (?:e|fica|sai))\s+(?:(?:um|uma|o|a|do|da|de)\s+)?(.{3,80})$/);
  if (price) {
    const query = trimNaturalModifiers(price[1]);
    return query && query.split(" ").length < 6 ? { type: "price", query } : null;
  }
  const question = text.match(/\b(?:tem|temos|vende|vendem|existe|possui|teria)\s+(?:(?:ai|por ai)\s+)?(.{3,95})$/);
  if (question) {
    const query = trimNaturalModifiers(question[1]);
    return query && query.split(" ").length < 6 &&
      !/^(?:como|que|alguma coisa|algo|entrega|retirada|pedido|troco|taxa|pix|cartao|dinheiro)$/.test(query)
      ? { type: "availability", query } : null;
  }
  // "Pudim tem aí?", "pudim vocês têm?"
  const reverse = text.match(/^(.{3,65})\s+(?:voce|voces)?\s*(?:tem|temos|vende|vendem)\s*(?:ai|hoje|agora)?$/);
  if (reverse) {
    const query = trimNaturalModifiers(reverse[1]);
    return query && query.split(" ").length < 6 ? { type: "availability", query } : null;
  }
  return null;
}

export function searchCatalog(query: string, products: CatalogEntry[]): {
  products: CatalogEntry[]; optionProducts: CatalogEntry[];
} {
  const ignored = new Set(["de", "da", "do", "com", "um", "uma", "o", "a", "pra", "para", "tambem", "ai"]);
  const tokens = normalizedText(query).split(" ").filter(token => token && !ignored.has(token));
  if (!tokens.length || tokens.length > 6) return { products: [], optionProducts: [] };
  const match = (name: string) => {
    const words = normalizedText(name).split(" ");
    return tokens.every(token => words.includes(token));
  };
  let matches = products.filter(p => match(p.name));
  // Typos are normal on WhatsApp ("chapaa", "coxinah", "refri"s): only when the
  // exact search finds nothing, accept words with one/two small differences.
  if (!matches.length) {
    const fuzzy = (name: string) => {
      const words = normalizedText(name).split(" ");
      return tokens.every(token => words.some(word => similarWord(token, word)));
    };
    matches = products.filter(p => fuzzy(p.name));
  }
  const optionProducts = products.filter(p =>
    !matches.includes(p) && (p.optionGroups || []).some(g => g.options.some(o => match(o.name))));
  return { products: matches, optionProducts };
}
const squeeze = (word: string) => word.replace(/(.)\1+/g, "$1");
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}
export function similarWord(token: string, word: string): boolean {
  if (token === word) return true;
  if (token.length < 3 || word.length < 3) return false;
  const a = squeeze(token), b = squeeze(word);
  if (a === b || a + "s" === b || a === b + "s") return true;
  if (a.length < 4 || b.length < 4) return false;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}
export function mayBeCartAddition(text: string): boolean {
  const t = normalizedText(text);
  if (/\b(?:saber|tem|existe|vende|disponivel|quanto|preco|valor|troca|trocar|substituir|remover|remova|remove|removeu|retirar|retire|retira|retirou|tirar|tire|tira|tirou|excluir|exclua|apagar|apague|sem)\b/.test(t)) return false;
  return /\b(?:adiciona|adicionar|acrescenta|acrescentar|inclui|incluir|coloca|colocar|bota|botar|poe|mais um|mais uma|tambem|quero outro|quero outra|me ve mais)\b/.test(t);
}

// Cardápio vindo do backend (/api/webhook/whatsapp/chat-order, action "catalog")
// e busca tolerante a erros de digitação, apelidos e abreviações.
import { levenshtein, norm } from "./text.js";

export type Option = { id: string; name: string; price: number };
export type OptionGroup = { id: string; name: string; min: number; max: number; options: Option[] };
export type Product = {
  id: string; name: string; description?: string; price: number; category?: string;
  promotionEnabled?: boolean; originalPrice?: number | null; optionGroups?: OptionGroup[];
};
export type StoreSummary = {
  isOpen: boolean; closesAt: string | null; opensAt: string | null; text: string;
  deliveryMode: string; deliveryFees: { name: string; fee: number }[];
  minimumOrderValue: number; preparationTime: { min: number; max: number } | null;
  paymentMethods: { id: string; label: string }[]; address: string | null;
};
export type CustomerProfile = {
  name: string | null;
  lastOrderAt?: string | null;
  lastOrder?: { paymentMethod: string | null; deliveryType: string | null } | null;
  savedAddress?: { address: string; number: string; neighborhood: string; complement?: string; reference?: string; city?: string; state?: string; cep?: string } | null;
} | null;
export type Catalog = {
  storeName: string; menuUrl: string; products: Product[]; soldOut: { id: string; name: string }[];
  store: StoreSummary; customer: CustomerProfile; learnedAliases?: { alias: string; productId: string }[];
};

const STOP = new Set(["de", "da", "do", "das", "dos", "com", "um", "uma", "uns", "umas", "o", "a", "os", "as", "e",
  "quero", "queria", "gostaria", "me", "manda", "ve", "vê", "pra", "para", "por", "favor", "tem", "voces", "vcs",
  "no", "na", "mais", "pfv", "pf", "ai", "aí", "so", "só", "sabor", "tipo"]);

const SYNONYMS: Record<string, string> = {
  refri: "refrigerante", refris: "refrigerante", hamburguer: "hamburguer", hamburger: "hamburguer", burguer: "hamburguer",
  burger: "hamburguer", hamburgue: "hamburguer", coca: "coca", cocacola: "coca cola", guarana: "guarana", agua: "agua",
  calabreza: "calabresa", chedar: "cheddar", cheder: "cheddar", catupiri: "catupiry", catupiri_: "catupiry",
  mussarela: "mussarela", muçarela: "mussarela", mucarela: "mussarela", mozarela: "mussarela", muzzarela: "mussarela",
  portuguesa: "portuguesa", frango: "frango", bacon: "bacon", becon: "bacon", baicon: "bacon", dog: "dog", hotdog: "hot dog",
  cachorro: "hot dog", "cachorro-quente": "hot dog", batatinha: "batata", fritas: "batata", acai: "acai", açai: "acai",
  peq: "pequena", pequeno: "pequena", med: "media", medio: "media", grd: "grande", gde: "grande", gg: "gigante",
  broto: "broto", lata: "350ml", latinha: "350ml", litrao: "2l",
};

export function searchKey(value: unknown): string {
  return norm(value)
    .replace(/\bx[\s-]*(?=[a-z])/g, "x")                 // x-tudo, x tudo -> xtudo
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:litros?|lts?|l)\b/g, (_m, n) => String(n).replace(",", ".") + "l")
    .replace(/(\d+)\s*(?:ml|mls)\b/g, "$1ml")
    .replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of searchKey(value).split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    const mapped = SYNONYMS[raw] ?? raw;
    for (const part of mapped.split(" ")) if (part) out.push(part);
  }
  return out;
}

function tokenScore(q: string, candidates: string[]): number {
  let best = 0;
  for (const c of candidates) {
    if (c === q) return 1;
    if (q.length >= 3 && c.startsWith(q)) best = Math.max(best, 0.9);
    else if (c.length >= 4 && q.startsWith(c)) best = Math.max(best, 0.8);
    else if (q.length >= 4 && c.length >= 4) {
      const d = levenshtein(q, c, 2);
      if (d === 1) best = Math.max(best, 0.8);
      else if (d === 2 && q.length >= 7) best = Math.max(best, 0.6);
    }
  }
  return best;
}

/** 0..1: quanto o texto da busca corresponde ao nome. */
export function matchScore(query: string, name: string, extra = ""): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const nameTokens = tokens(name);
  const all = nameTokens.concat(tokens(extra));
  let sum = 0;
  for (const t of q) sum += Math.max(tokenScore(t, nameTokens), tokenScore(t, all) * 0.7);
  let score = sum / q.length;
  // Prefere o nome mais curto quando os dois cobrem a busca ("coca 2l" -> "Coca cola 2L").
  const uncovered = nameTokens.filter((t) => tokenScore(t, q) < 0.6).length;
  score -= Math.min(0.15, uncovered * 0.03);
  // Números (2l, 350ml, tamanhos) que não batem pesam bastante.
  const qNumbers = q.filter((t) => /\d/.test(t));
  if (qNumbers.some((t) => !nameTokens.includes(t))) score -= 0.25;
  return Math.max(0, Math.min(1, score));
}

export type Match = { product: Product; score: number; via?: string };

export function searchProducts(catalog: Catalog, query: string, limit = 6): Match[] {
  const q = searchKey(query);
  if (!q) return [];
  const aliases = new Map<string, string[]>();
  for (const a of catalog.learnedAliases || []) aliases.set(a.productId, [...(aliases.get(a.productId) || []), a.alias]);
  const matches: Match[] = [];
  for (const product of catalog.products) {
    const optionNames = (product.optionGroups || []).flatMap((g) => g.options.map((o) => o.name)).join(" ");
    let score = matchScore(query, product.name, [product.category, ...(aliases.get(product.id) || [])].join(" "));
    for (const alias of aliases.get(product.id) || []) score = Math.max(score, matchScore(query, alias) * 0.95);
    let via: string | undefined;
    // Sabores/opções (ex.: "calabresa" dentro de "Pizza Média") ajudam a achar o produto.
    if (optionNames) {
      const optionScore = matchScore(query, product.name + " " + optionNames) * 0.85;
      if (optionScore > score) { score = optionScore; via = "opcao"; }
    }
    if (score >= 0.5) matches.push({ product, score, via });
  }
  return matches.sort((a, b) => b.score - a.score || a.product.name.length - b.product.name.length).slice(0, limit);
}

export function soldOutMatch(catalog: Catalog, query: string): string | null {
  let best: { name: string; score: number } | null = null;
  for (const item of catalog.soldOut || []) {
    const score = matchScore(query, item.name);
    if (score >= 0.75 && (!best || score > best.score)) best = { name: item.name, score };
  }
  return best?.name || null;
}

/** Produto claro: único bom resultado, ou o primeiro bem à frente do segundo. */
export function resolveProduct(catalog: Catalog, ref: string): { product?: Product; candidates: Product[] } {
  const byId = catalog.products.find((p) => p.id === ref);
  if (byId) return { product: byId, candidates: [byId] };
  const found = searchProducts(catalog, ref, 5);
  if (!found.length) return { candidates: [] };
  const [first, second] = found;
  const exact = found.filter((m) => searchKey(m.product.name) === searchKey(ref));
  if (exact.length === 1) return { product: exact[0].product, candidates: [exact[0].product] };
  if (first.score >= 0.6 && (!second || first.score - second.score >= 0.12)) return { product: first.product, candidates: [first.product] };
  return { candidates: found.filter((m) => m.score >= first.score - 0.12).map((m) => m.product) };
}

export function resolveOption(product: Product, ref: string): { group: OptionGroup; option: Option } | null {
  let best: { group: OptionGroup; option: Option; score: number } | null = null;
  for (const group of product.optionGroups || []) {
    for (const option of group.options) {
      // O nome do grupo ajuda: "borda catupiry" -> grupo Borda, opção Catupiry.
      const score = option.id === ref ? 1 : Math.max(matchScore(ref, option.name), matchScore(ref, option.name, group.name));
      if (score >= 0.6 && (!best || score > best.score)) best = { group, option, score };
    }
  }
  return best ? { group: best.group, option: best.option } : null;
}

export function describeProduct(product: Product, soldOut = false) {
  return {
    id: product.id, nome: product.name, preco: product.price, categoria: product.category || "",
    ...(product.description ? { descricao: product.description } : {}),
    ...(product.promotionEnabled && product.originalPrice ? { promocao: { de: product.originalPrice, por: product.price } } : {}),
    ...(soldOut ? { esgotado: true } : {}),
    grupos: (product.optionGroups || []).map((g) => ({
      nome: g.name, minimo: g.min, maximo: g.max,
      opcoes: g.options.map((o) => (o.price ? o.name + " (+" + o.price.toFixed(2) + ")" : o.name)),
    })),
  };
}

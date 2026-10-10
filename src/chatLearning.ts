// src/chatLearning.ts
/**
 * Tenant-safe product alias learner. Never stores raw conversations,
 * trains a model, changes prices or assumes an unconfirmed correction.
 */
export type CatalogProduct = { id: string; name: string };
export type LearnedAlias = { alias: string; productId: string };
export type AliasCandidate = { alias: string; productId: string };

const normalize = (value: unknown): string =>
  String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function validAlias(raw: unknown, productId: string, products: CatalogProduct[]): string {
  if (typeof raw !== "string" || raw.length > 60) return "";
  const alias = normalize(raw);
  if (alias.length < 4 || alias.length > 40 || alias.split(" ").length > 3 ||
      !/[a-z]/.test(alias) || /\b(?:rua|avenida|bairro|pix|cartao|dinheiro|pedido|entrega|retirada|telefone)\b/.test(alias) ||
      !products.some(p => p.id === productId)) return "";
  if (products.some(p => {
    const label = normalize(p.name);
    return label === alias || label.startsWith(alias + " ");
  })) return "";
  return alias;
}

export function explicitProductCorrection(input: string, products: CatalogProduct[]): AliasCandidate | null {
  // Requiring an explicit equivalence prevents interpreting ordinary product changes
  // ("troca hamburguer por pizza") as a durable alias.
  const text = normalize(input).replace(/^(?:nao |na verdade |isso )+/, "");
  const match = text.match(
    /^(?:quando (?:eu )?(?:digo|falo) )?(.{4,40}?) (?:e o mesmo que|quer dizer|significa|quero dizer|e) (?:o |a |um |uma )?(.{3,100})$/
  );
  if (!match) return null;
  const [, source, destination] = match;
  const matches = products.filter(p => normalize(p.name) === destination);
  if (matches.length !== 1) return null;
  const alias = validAlias(source, matches[0].id, products);
  return alias ? { alias, productId: matches[0].id } : null;
}

export function applyApprovedAliases(
  text: string, aliases: LearnedAlias[] | undefined, products: CatalogProduct[],
): string {
  if (!Array.isArray(aliases) || aliases.length === 0) return text;
  let output = normalize(text);
  const grouped = new Map<string, Set<string>>();
  for (const entry of aliases.slice(0, 200)) {
    const alias = validAlias(entry?.alias, entry?.productId, products);
    if (!alias || alias !== entry.alias) continue;
    const ids = grouped.get(alias) || new Set<string>();
    ids.add(entry.productId);
    grouped.set(alias, ids);
  }
  for (const [alias, ids] of [...grouped].sort((a, b) => b[0].length - a[0].length)) {
    if (ids.size !== 1) continue;
    const product = products.find(p => p.id === [...ids][0]);
    if (!product) continue;
    // Valid aliases contain only alphanumerics and spaces (no regex metacharacters).
    output = output.replace(new RegExp("(^|[^a-z0-9])" + alias + "(?=$|[^a-z0-9])", "g"),
      (_whole, before: string) => before + normalize(product.name));
  }
  return output;
}

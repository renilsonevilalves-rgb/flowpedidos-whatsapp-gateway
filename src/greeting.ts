// Detector de saudações tolerante a gírias, letras repetidas e erros de digitação.
// Ex.: "Oiê", "oiii", "opa", "olaaa", "boa trade", "bom diaaa", "eae", "salve", "oi td bem?".
// Só retorna true quando a mensagem inteira é saudação (não engole perguntas/pedidos).

function collapse(word: string) {
  return word.replace(/(.)\1+/g, "$1");
}

function normalize(input: unknown) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Palavras que, sozinhas, já são saudação (forma "colapsada", sem letras repetidas).
const CORE = new Set([
  "oi", "oie", "oiee", "oii", "ola", "hola", "alo", "opa", "opaa", "epa", "eai", "eae", "eai", "iae", "iai", "ae", "ei", "hey", "hi",
  "hello", "salve", "fala", "coe", "qual", "bomdia", "boatarde", "boanoite", "bd", "bt", "bn", "boas",
  "alguem", "tdb", "tudobem", "blz", "beleza", "suave", "dia", "tarde", "noite", "bomdiaa",
].map(collapse));

// Palavras que podem acompanhar uma saudação ("oi pessoal tudo bem?").
const FILLER = new Set([
  "e", "a", "o", "ai", "bom", "boa", "bao", "bon", "tudo", "td", "tds", "bem", "bom", "como", "vai", "vao", "esta", "ta", "tao",
  "pessoal", "gente", "galera", "moco", "moca", "amigo", "amiga", "amigos", "querida", "querido", "vc", "voce", "voces", "vcs",
  "loja", "tem", "ai", "aqui", "por", "favor", "pfv", "pf", "td", "tranquilo", "tranquila", "tudo", "certo", "joia",
  "turma", "povo", "boa", "tardee", "dona", "seu", "sr", "sra", "irmao", "mano", "parceiro", "chefe", "kkk", "k", "rs",
].map(collapse));

// Palavras "fortes" que aceitam 1 erro de digitação (troca, falta, sobra ou inversão de letra).
const FUZZY = ["tarde", "noite", "beleza", "salve", "hello", "bomdia", "boatarde", "boanoite", "tudobem", "pessoal", "galera"];

function osa(a: string, b: string) {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function classify(token: string): "core" | "filler" | null {
  const t = collapse(token);
  if (CORE.has(t)) return "core";
  // "oiê", "oiie", "oizinho", "olaa", "olar"
  if (/^o+i+e*$/.test(token) || /^oiz+inh[oa]$/.test(t) || /^ol+a+r?$/.test(t)) return "core";
  if (FILLER.has(t)) return "filler";
  if (t.length >= 4) {
    for (const w of FUZZY) if (Math.abs(w.length - t.length) <= 1 && osa(t, w) <= 1) return "core";
  }
  return null;
}

export function isGreetingMessage(input: unknown): boolean {
  const text = normalize(input);
  if (!text || text.length > 60) return false;
  const tokens = text.replace(/\be a[ie]\b/g, "eai").split(" ");
  if (tokens.length > 8) return false;
  let core = 0;
  for (const tok of tokens) {
    const kind = classify(tok);
    if (!kind) return false;
    if (kind === "core") core++;
  }
  return core > 0;
}

// Saudação pelo horário de Brasília: 05h–11h59 bom dia, 12h–17h59 boa tarde, 18h–04h59 boa noite.
export function periodGreeting(now: Date = new Date(), timeZone = process.env.WHATSAPP_TIMEZONE || "America/Sao_Paulo") {
  let hour = now.getUTCHours() - 3;
  try {
    const part = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now);
    const parsed = Number(String(part).replace(/\D/g, ""));
    if (Number.isFinite(parsed)) hour = parsed;
  } catch {
    // fallback UTC-3 acima
  }
  hour = ((hour % 24) + 24) % 24;
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

// Troca um "Olá"/"Oi" genérico no início da mensagem pela saudação do período.
// Mensagens que já começam com outra coisa (ou já têm bom dia/boa tarde/boa noite) ficam intactas.
export function applyPeriodGreeting(text: string, now: Date = new Date()) {
  const value = String(text || "");
  return value.replace(/^(\s*)(ol[áa]|oi[eê]?)(?=[\s!,.👋]|$)/i, (_m, lead) => `${lead}${periodGreeting(now)}`);
}

// src/chatOrder.ts
import { randomUUID } from "node:crypto";

type Item = { productId: string; quantity: number; notes?: string; selectedOptions?: Array<{ id: string; groupId: string; quantity: number }> };
type Draft = {
  draftId: string; items: Item[]; name: string; deliveryType: string;
  address: string; number: string; neighborhood: string; complement: string; reference: string; paymentMethod: string;
};
type Catalog = { menuUrl: string; deliveryMode: string; products: Array<{
  id: string; name: string; price: number;
  optionGroups?: Array<{ id: string; name: string; min: number; max: number; options: Array<{ id: string; name: string; price: number }> }>;
}> };
type State = { draft: Draft; catalog: Catalog; updatedAt: number; quote?: string; quoteExpiry?: number };
type Params = {
  sessionId: string; customerJid: string; customerPhone?: string | null; text: string;
  sendMessage: (jid: string, data: { text: string }) => Promise<unknown>;
  logger: { warn: (fields: Record<string, unknown>, message: string) => void };
};
const enabled = process.env.WHATSAPP_CHAT_ORDERS_ENABLED === "true";
const endpoint = String(process.env.VERCEL_API_URL || "").replace(/\/$/, "") + "/api/webhook/whatsapp/chat-order";
const keys = [process.env.API_KEY, process.env.API_KEY_2].filter(Boolean) as string[];
const geminiKey = String(process.env.GEMINI_API_KEY || "");
const geminiModel = String(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite");
const drafts = new Map<string, State>();
const serialized = new Map<string, Promise<boolean>>();
const clean = (v: unknown, max = 240) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const norm = (v: unknown) => clean(v, 2000).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const currency = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
const yes = (t: string) => /^(sim|confirmo|pode confirmar|isso mesmo|ok|fechado)[.!?\s]*$/i.test(norm(t));
const no = (t: string) => /^(nao|quero mudar|alterar|corrigir)[.!?\s]*$/i.test(norm(t));
const cancel = (t: string) => /^(cancelar rascunho|desistir|esquece|deixa pra la|cancelar esse pedido)[.!?\s]*$/i.test(norm(t));
function startsOrder(text: string) {
  const t = norm(text);
  if (/(meu pedido|pedido anterior|pedido que fiz|alterar pedido|cancelar pedido|rastrear|acompanhar|trocar pagamento)/.test(t)) return false;
  return /(pelo whatsapp|por aqui mesmo|aqui no chat|sem cardapio|quero pedir aqui|pedido pelo chat|me ve\b|vou querer\b|quero\s+\d+\s|queria\s+\d+\s)/.test(t);
}
function fresh(): Draft {
  return { draftId: randomUUID(), items: [], name: "", deliveryType: "", address: "", number: "",
    neighborhood: "", complement: "", reference: "", paymentMethod: "" };
}
async function send(p: Params, message: string) {
  await p.sendMessage(p.customerJid, { text: clean(message, 4000) });
}
async function requestBackend(p: Params, action: string, data: Record<string, unknown>): Promise<any> {
  let lastError = "Sistema temporariamente indisponível.";
  for (const key of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ action, sessionId: p.sessionId, ...data }), signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok) return result;
      if (response.status === 403 && action === "catalog") return null;
      if (response.status === 401) { lastError = "Não autorizado."; continue; }
      throw new Error(clean(result.error, 300) || "Erro HTTP " + response.status);
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error("O sistema demorou a responder. Tente novamente.");
      if (error instanceof Error && !/fetch failed/i.test(error.message)) throw error;
      lastError = "O sistema está indisponível. Tente novamente.";
    } finally { clearTimeout(timer); }
  }
  throw new Error(lastError);
}
function modelCatalog(c: Catalog) {
  return c.products.map((p) => {
    const groups = (p.optionGroups || []).map((g) => g.name + " [groupId=" + g.id + ", min=" + g.min + ", max=" + g.max + "]: " +
      g.options.map((o) => o.name + " [id=" + o.id + "]").join(", ")).join("; ");
    return p.name + " [productId=" + p.id + ", R$" + p.price + "]" + (groups ? " | " + groups : "");
  }).join("\n").slice(0, 48000);
}
function validatedDraft(output: any, state: State): Draft | null {
  const next = output?.draft;
  if (!next || typeof next !== "object" || !Array.isArray(next.items)) return null;
  const catalog = new Map(state.catalog.products.map((p) => [p.id, p]));
  const items: Item[] = [];
  for (const raw of next.items.slice(0, 40)) {
    const id = clean(raw?.productId, 80);
    const product = catalog.get(id);
    const quantity = Number(raw?.quantity);
    if (!product || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) continue;
    const optionList: Item["selectedOptions"] = [];
    for (const o of (Array.isArray(raw.selectedOptions) ? raw.selectedOptions : []).slice(0, 50)) {
      const groupId = clean(o?.groupId, 500);
      const optionId = clean(o?.id, 120);
      const group = (product.optionGroups || []).find((g) => g.id === groupId);
      const option = group?.options.find((x) => x.id === optionId);
      const amount = Number(o?.quantity || 1);
      if (option && Number.isSafeInteger(amount) && amount > 0 && amount <= 100)
        optionList.push({ id: optionId, groupId, quantity: amount });
    }
    items.push({ productId: id, quantity, notes: clean(raw.notes, 200), selectedOptions: optionList });
  }
  const type = clean(next.deliveryType, 20);
  const pay = clean(next.paymentMethod, 30);
  return {
    draftId: state.draft.draftId, items, name: clean(next.name, 120),
    deliveryType: ["delivery", "pickup"].includes(type) ? type : "",
    address: clean(next.address, 250), number: clean(next.number, 30),
    neighborhood: clean(next.neighborhood, 100), complement: clean(next.complement, 160),
    reference: clean(next.reference, 160),
    paymentMethod: ["pix", "credit", "money", "online_pix", "online_credit", "online_debit"].includes(pay) ? pay : "",
  };
}

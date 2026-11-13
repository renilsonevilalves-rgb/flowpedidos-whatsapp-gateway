// Chamadas ao sistema principal (Vercel). Preço, taxa e total vêm SEMPRE daqui.

export type BackendResult = { ok: boolean; status: number; data: any; network?: boolean };

function baseUrl() {
  return String(process.env.VERCEL_API_URL || "").replace(/\/$/, "");
}

export function backendConfigured() {
  return Boolean(baseUrl() && (process.env.API_KEY || process.env.API_KEY_2));
}

export async function chatOrder(body: Record<string, unknown>, timeoutMs = 12_000): Promise<BackendResult> {
  const keys = [process.env.API_KEY, process.env.API_KEY_2].filter((v, i, all): v is string => Boolean(v) && all.indexOf(v) === i);
  let last: BackendResult = { ok: false, status: 0, data: {}, network: true };
  for (const key of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(baseUrl() + "/api/webhook/whatsapp/chat-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      last = { ok: response.ok && data?.ok !== false, status: response.status, data };
      if (response.status !== 401) return last;
    } catch {
      last = { ok: false, status: 0, data: {}, network: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

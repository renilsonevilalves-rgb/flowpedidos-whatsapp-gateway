// Shared test helper: backend mocks written before the AI could see placed
// orders answer "no changeable order" to the order lookup automatically.
const WRAPPED = Symbol("noRecentOrderWrapper");
let inner = globalThis.fetch;
function wrap(fn) {
  if (typeof fn !== "function" || fn[WRAPPED]) return fn;
  const wrapped = async (url, options) => {
    try {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (String(url).includes("order-self-service") && body.action === "lookup") {
        return new Response(JSON.stringify({ ok: false, code: "NO_ACTIONABLE_ORDER" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
    } catch {}
    return fn(url, options);
  };
  wrapped[WRAPPED] = fn;
  return wrapped;
}
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  get() { return wrap(inner); },
  set(value) { inner = value && value[WRAPPED] ? value[WRAPPED] : value; },
});

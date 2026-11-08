// CyberNote AI közvetítő – Cloudflare Worker
// Az app ide küldi a kérést, a Worker hozzáteszi a titkos API-kulcsot,
// és továbbítja a Claude API-nak. A kulcs soha nem kerül az appba.
//
// Beállítások (Worker › Settings › Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret)   – az sk-ant-… kulcs
//   APP_TOKEN          (Secret)   – saját hosszú jelszó; az app ezzel azonosítja magát
//   ALLOWED_ORIGIN     (Text)     – https://sevro95.github.io
//   DEFAULT_MODEL      (Text)     – pl. a Sonnet 5.5 modellazonosítója a Console-ból
//   MODELS             (Text, opcionális) – engedélyezett modellek vesszővel elválasztva

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://sevro95.github.io";
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-CyberNote-Token",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "CyberNote AI proxy" });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    if (origin && origin !== allowedOrigin) return json({ error: "origin_not_allowed" }, 403);
    if (!env.ANTHROPIC_API_KEY || !env.APP_TOKEN) return json({ error: "server_not_configured" }, 500);
    if (!safeEqual(request.headers.get("X-CyberNote-Token") || "", env.APP_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 10_000_000) return json({ error: "too_large" }, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }

    const allowed = (env.MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const model = String(body.model || env.DEFAULT_MODEL || "");
    if (!model.startsWith("claude-") || (allowed.length && !allowed.includes(model))) {
      return json({ error: "model_not_allowed", model }, 400);
    }
    if (!Array.isArray(body.messages)) return json({ error: "messages_required" }, 400);

    const payload = {
      model,
      max_tokens: Math.min(Number(body.max_tokens) || 1500, 4000),
      messages: body.messages,
    };
    if (body.system !== undefined) payload.system = body.system;
    if (typeof body.temperature === "number") payload.temperature = body.temperature;

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: "upstream_unreachable" }, 502);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};

// Időzítés-független összehasonlítás a tokenhez
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

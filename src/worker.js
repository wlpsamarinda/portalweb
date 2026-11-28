/**
 * WONDERLAND SAMARINDA — Gerbang website (Cloudflare Worker)
 * -----------------------------------------------------------
 * - Menyajikan file website dari folder frontend/ (binding ASSETS)
 * - /api/config  : pengaturan publik untuk browser (site key Turnstile)
 * - /api/catalog : katalog dari Apps Script (di-cache 60 detik di edge)
 * - /api/order   : pemeriksaan anti-spam lalu diteruskan ke Apps Script dengan kunci rahasia
 * - Mode maintenance & header keamanan untuk semua halaman
 *
 * Pengaturan (Cloudflare > Workers > wonderlandsamarindapages > Settings > Variables and Secrets):
 *   GAS_URL            (variabel, sudah ada di wrangler.jsonc)  URL /exec Apps Script
 *   GAS_SECRET         (secret)    sama dengan ORDER_SECRET di Apps Script
 *   TURNSTILE_SITE_KEY (variabel)  dari Cloudflare Turnstile
 *   TURNSTILE_SECRET   (secret)    dari Cloudflare Turnstile
 *   TURNSTILE_MODE     (variabel)  "auto" (bawaan) = captcha hanya saat order melonjak,
 *                                  "always" = captcha untuk setiap order
 *   MAINTENANCE        (variabel)  "1" = website ditutup sementara, "0"/kosong = buka
 *   PREVIEW_KEY        (secret, opsional) buka website saat maintenance via ?preview=KUNCI
 */

const MAX_BODY = 10_000;          // byte
const MIN_FILL_MS = 2500;         // manusia butuh > 2,5 detik untuk mengisi form

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      let res;
      try {
        res = await handleApi(request, env, ctx, url);
      } catch (err) {
        console.error(err);
        res = json({ ok: false, error: "Terjadi kesalahan server" }, 500);
      }
      return withSecurityHeaders(res, { api: true });
    }

    if (env.MAINTENANCE === "1" && url.pathname !== "/img/logo.png" && !(await previewAllowed(request, env, url))) {
      return withSecurityHeaders(maintenancePage());
    }
    if (url.searchParams.has("preview") && env.PREVIEW_KEY && url.searchParams.get("preview") === env.PREVIEW_KEY) {
      const r = new Response(null, { status: 302, headers: { Location: "/" } });
      r.headers.append("Set-Cookie", `wl_preview=${env.PREVIEW_KEY}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`);
      return r;
    }

    const res = await env.ASSETS.fetch(request);
    return withSecurityHeaders(res);
  },
};

/* ================= API ================= */

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json({ ok: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY || "", turnstileMode: turnstileMode(env),
      maintenance: env.MAINTENANCE === "1" },
      200, { "Cache-Control": "public, max-age=60" });
  }

  if (path === "/api/catalog" && request.method === "GET") {
    return catalog(env, ctx);
  }

  if (path === "/api/order") {
    if (request.method !== "POST") return json({ ok: false, error: "Metode tidak diizinkan" }, 405);
    return order(request, env);
  }

  return json({ ok: false, error: "Tidak ditemukan" }, 404);
}

async function catalog(env, ctx) {
  if (!env.GAS_URL) return json({ ok: false, error: "GAS_URL belum diatur" }, 500);
  const cache = caches.default;
  const key = new Request("https://cache.wonderland.internal/catalog");
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);

  const r = await fetch(env.GAS_URL + "?action=catalog", { redirect: "follow" });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { return json({ ok: false, error: "Katalog tidak tersedia" }, 502); }
  const res = json(data, 200, { "Cache-Control": "public, max-age=60" });
  if (data.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function order(request, env) {
  if (env.MAINTENANCE === "1") return json({ ok: false, error: "Website sedang dalam perbaikan" }, 503);
  if (!env.GAS_URL || !env.GAS_SECRET) return json({ ok: false, error: "Server belum dikonfigurasi" }, 500);

  // 1. Hanya dari halaman website sendiri
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  if (!origin || origin !== self) return json({ ok: false, error: "Tidak diizinkan" }, 403);

  // 2. Ukuran & format
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return json({ ok: false, error: "Permintaan terlalu besar" }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "Permintaan terlalu besar" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Format tidak valid" }, 400); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Format tidak valid" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "";

  // 3. Jebakan bot (honeypot & terlalu cepat): pura-pura berhasil, tidak disimpan
  if ((body.website && String(body.website).trim()) || !(Number(body.elapsed) >= MIN_FILL_MS)) {
    console.log("Bot ditolak (honeypot/terlalu cepat)", ip);
    return json({ ok: true, ref: "WL-" + Math.random().toString(36).slice(2, 8).toUpperCase(), total: 0, lines: [] });
  }

  // 4. Verifikasi Cloudflare Turnstile
  //    mode "always": wajib untuk setiap order; mode "auto": diperiksa bila dikirim,
  //    dan diwajibkan Apps Script saat order seluruh web melonjak (code CAPTCHA_REQUIRED)
  let verified = false;
  const token = String(body.turnstile || "");
  if (env.TURNSTILE_SECRET && turnstileMode(env) === "always" && !token)
    return json({ ok: false, error: "Selesaikan verifikasi keamanan terlebih dahulu", code: "CAPTCHA_REQUIRED" }, 400);
  if (env.TURNSTILE_SECRET && token) {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const out = await v.json().catch(() => ({}));
    if (!out.success) return json({ ok: false, error: "Verifikasi keamanan gagal. Coba lagi.", code: "CAPTCHA_REQUIRED" }, 403);
    verified = true;
  }

  // 5. Teruskan ke Apps Script dengan kunci rahasia (hanya field yang diperlukan)
  const items = Array.isArray(body.items) ? body.items.slice(0, 30).map(it => ({
    type: String(it?.type || "").slice(0, 2), id: String(it?.id || "").slice(0, 40),
    qty: Number(it?.qty) || 0, date: String(it?.date || "").slice(0, 10),
  })) : [];
  const payload = {
    action: "order", secret: env.GAS_SECRET, ip, verified,
    name: String(body.name || "").slice(0, 80),
    phone: String(body.phone || "").slice(0, 20),
    source: String(body.source || "direct").slice(0, 100),
    items,
  };
  const r = await fetch(env.GAS_URL, {
    method: "POST", redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { return json({ ok: false, error: "Server pesanan tidak merespons" }, 502); }
  return json(data, data.ok ? 200 : 400);
}

/* ================= MAINTENANCE ================= */

async function previewAllowed(request, env, url) {
  if (!env.PREVIEW_KEY) return false;
  if (url.searchParams.get("preview") === env.PREVIEW_KEY) return true;
  const cookie = request.headers.get("Cookie") || "";
  return cookie.split(/;\s*/).includes("wl_preview=" + env.PREVIEW_KEY);
}

function maintenancePage() {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sedang Perbaikan — Wonderland Samarinda</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F6F3E9;font-family:system-ui,sans-serif;color:#14231B;padding:16px}
main{max-width:440px;text-align:center;background:#fff;border-radius:24px;padding:36px 28px;border:1px solid #E4DFCF}
img{width:96px;height:96px;object-fit:contain}h1{font-size:24px;margin:12px 0 8px;color:#153E2D}p{line-height:1.6;color:#4B5B52;margin:0 0 20px}
a{display:inline-block;background:#F5C542;color:#153E2D;font-weight:800;text-decoration:none;padding:14px 22px;border-radius:999px}</style></head>
<body><main><img src="/img/logo.png" alt="Wonderland Samarinda"><h1>Website sedang dalam perbaikan</h1>
<p>Kami sedang meningkatkan layanan. Taman tetap buka setiap hari 08.30–17.30 WITA. Untuk info dan pemesanan, hubungi kami via WhatsApp.</p>
<a href="https://wa.me/6282254335976">Chat WhatsApp</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html;charset=utf-8", "Retry-After": "3600", "Cache-Control": "no-store" } });
}

/* ================= UTIL ================= */

function turnstileMode(env) {
  return env.TURNSTILE_MODE === "always" ? "always" : "auto";
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com https://maps.google.com https://www.google.com",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(res, opts = {}) {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!opts.api) h.set("Content-Security-Policy", CSP);
  return r;
}

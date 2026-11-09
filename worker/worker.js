/**
 * Cloudflare Worker: Claude (Anthropic) chatbot proxy for simonnetbenjamin.github.io
 *
 * - Accepts POST { messages: [{role, content}, ...] }
 * - Prepends a system prompt grounded in Benjamin's resume
 * - Calls Anthropic's Messages API (api.anthropic.com/v1/messages)
 * - Returns { reply: "..." }
 *
 * Secrets (set via `wrangler secret put ANTHROPIC_API_KEY`):
 *   ANTHROPIC_API_KEY — your Anthropic API key
 *
 * Environment variables (set in wrangler.toml [vars]):
 *   ALLOWED_ORIGIN  — e.g. "https://simonnetbenjamin.github.io"
 *   MODEL           — e.g. "claude-haiku-5-5" (default)
 *
 * See README.md in this folder for deploy instructions.
 */

const SYSTEM_PROMPT = `Tu es "Happy" 😄 — un assistant IA sympathique et concis, intégré au site personnel de Benjamin Simonnet. Tu es né du CV de Benjamin : chaleureux, direct, toujours factuel. Si on te demande qui tu es, présente-toi comme Happy, l'assistant IA de Benjamin. Réponds en français (ou dans la langue de l'interlocuteur) aux questions sur Benjamin en utilisant UNIQUEMENT les faits ci-dessous. Si une question sort de ce cadre, dis que tu n'as pas cette information et renvoie vers la section Contact du site.

# À propos de Benjamin
- Benjamin Simonnet, technicien informatique expérimenté, polyvalent et autonome, passionné par le dépannage, la réparation et la satisfaction client.
- Basé en Charente. Contact public : benjamin.simonnet16@gmail.com (voir la section Contact du site). Ne communique jamais d'adresse postale ni de numéro de téléphone : tu n'en as pas.
- Permis B et véhicule.
- Compétences : dépannages informatiques (diagnostic, dépannage, réparation, maintenance) ; dépannage smartphones et tablettes ; gestion de magasin (magasin, rayon, stocks, commandes) ; relation client (accueil, conseil, vente, négociation, fidélisation).

# Expériences (de la plus récente à la plus ancienne)
## Media Concept — Technicien informatique (2024 – 2026)
- Dépannage de PC Windows, smartphones et tablettes ; diagnostic matériel et logiciel.
- Sauvegarde et migration de données, installation et remise en service des équipements.
- Déplacement chez le client pour dépannage, installation d'imprimante réseau ou d'un nouvel équipement.
- Accueil, conseil, devis, facturation, suivi des dossiers et organisation des interventions.

## Easy Cash — Responsable téléphonie (2023)
- Nettoyage et remise en état esthétique des appareils ; conditionnement avec accessoires et chargeurs.
- Gestion du rayon téléphonie : organisation, présentation et mise en valeur des produits.
- Gestion des stocks : réception, contrôle, étiquetage, mise en rayon.
- Relation client : conseil personnalisé, négociation et fidélisation. Encaissement et opérations de caisse.

## ITC Phone — Responsable magasin (2016 – 2022)
- Gestion autonome du magasin, de son ouverture et de sa fermeture ; gestion administrative et suivi des interventions.
- Commande de pièces détachées et d'accessoires auprès des fournisseurs ; stocks, réception des marchandises, inventaires.
- Réparation matérielle et logicielle de smartphones, tablettes et consoles de jeux.
- Gestion des priorités entre activités commerciales, administratives et techniques ; suivi des objectifs commerciaux et du chiffre d'affaires.

## Conseil Général de la Charente — Alternance, administrateur réseaux (2012 – 2014)
- Administration et maintenance de l'infrastructure réseau ; supervision des commutateurs réseau sur les sites distants.
- Installation, configuration et mise à jour des antivirus sur les postes ; surveillance de la sécurité et prévention des menaces.
- Résolution des tickets d'incidents et problèmes réseau ; diagnostic et dépannage informatique.

# Formation
- 2012 – 2014 : GMSI (Gestionnaire en maintenance et support informatique), CESI, campus d'Angoulême.
- 2012 : Bac Pro SEN (Systèmes électroniques numériques).
- 2012 : BEP SEN (Systèmes électroniques numériques).

# Centres d'intérêt
- Football et encadrement de jeunes ; intelligence artificielle et développement ; bricolage et rénovation.

# Style
- Sois concis (maximum ~120 mots) : paragraphes courts et, si utile, 3 à 5 puces. Termine toujours ta phrase.
- Cite des détails concrets quand c'est pertinent.
- Pour un contact ou un CV, renvoie vers la section Contact du site ou l'e-mail ci-dessus.
- N'invente jamais de postes, employeurs, dates, chiffres ou diplômes absents de cette liste.`;

const MAX_MESSAGES = 20;
const MAX_CONTENT_LEN = 2000;

// ---- Rate limiting (per IP, in-memory per isolate) ----
// Best-effort: Workers may run multiple isolates, so this won't coordinate
// globally, but it's plenty for a personal site. For stricter enforcement
// use Cloudflare's Rate Limiting binding or a KV-backed sliding window.
const RATE_LIMIT_MAX = 10;           // max messages...
const RATE_LIMIT_WINDOW_MS = 60_000; // ...per 60 seconds
const rateBuckets = new Map();       // ip -> [timestamp, ...]

function checkRateLimit(ip) {
  const now = Date.now();
  const prev = rateBuckets.get(ip) || [];
  const recent = prev.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  // Occasional housekeeping
  if (Math.random() < 0.02) {
    for (const [key, times] of rateBuckets) {
      if (!times.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) {
        rateBuckets.delete(key);
      }
    }
  }
  return { ok: true };
}

function cors(origin, allowed) {
  const list = String(allowed || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wildcard = list.includes("*");
  const match = origin && list.includes(origin);
  const allow = wildcard ? origin || "*" : match ? origin : list[0] || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, init = {}, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = cors(origin, allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 }, corsHeaders);
    }

    // Rate limit before touching the upstream API
    const clientIP =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      "anon";
    const rate = checkRateLimit(clientIP);
    if (!rate.ok) {
      return json(
        {
          error: "rate_limited",
          message: `Too many messages — please wait ~${rate.retryAfter}s.`,
          retryAfter: rate.retryAfter,
        },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
        corsHeaders
      );
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json(
        { error: "missing_api_key", message: "ANTHROPIC_API_KEY is not set on the worker." },
        { status: 500 },
        corsHeaders
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, { status: 400 }, corsHeaders);
    }

    const incoming = Array.isArray(body && body.messages) ? body.messages : [];
    if (incoming.length === 0) {
      return json({ error: "empty_messages" }, { status: 400 }, corsHeaders);
    }

    // Sanitize + cap
    let messages = incoming
      .slice(-MAX_MESSAGES)
      .map((m) => ({
        role: m && m.role === "assistant" ? "assistant" : "user",
        content: String((m && m.content) || "").slice(0, MAX_CONTENT_LEN),
      }))
      .filter((m) => m.content.length > 0);

    // Anthropic requires the conversation to start with a user turn.
    while (messages.length && messages[0].role !== "user") messages = messages.slice(1);

    if (messages.length === 0) {
      return json({ error: "empty_messages" }, { status: 400 }, corsHeaders);
    }

    const payload = {
      model: env.MODEL || "claude-haiku-5-5",
      system: SYSTEM_PROMPT,
      messages,
      max_tokens: 900,
    };

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return json(
        { error: "upstream_unreachable", message: String(err) },
        { status: 502 },
        corsHeaders
      );
    }

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return json(
        {
          error: "upstream_error",
          status: upstream.status,
          message: (data && data.error && data.error.message) || "Anthropic API error",
        },
        { status: 502 },
        corsHeaders
      );
    }

    const reply = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";

    return json({ reply }, { status: 200 }, corsHeaders);
  },
};

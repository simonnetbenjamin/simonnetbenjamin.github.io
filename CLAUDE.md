# CLAUDE.md

Site personnel de Benjamin Simonnet (`simonnetbenjamin.github.io`). HTML/CSS/JS statique, sans build. Un Cloudflare Worker (`worker/`) sert de proxy vers l'API Claude (Anthropic) pour le chatbot **Happy 😄** ; la clé API reste côté Worker.

## Commandes
```bash
python3 -m http.server 8000              # aperçu local, http://localhost:8000
cd worker && wrangler deploy             # déployer le Worker
cd worker && wrangler secret put ANTHROPIC_API_KEY --name happy-chat
node --check js/chatbot.js js/main.js js/config.js worker/worker.js
```
Déploiement du site : push sur `main` (GitHub Pages sert la racine).

## Architecture
- `index.html` : tout le contenu (hero, frise + cartes, contact, chatbot flottant). Langue : français.
- `css/styles.css` : tokens dans `:root` (thème nuit « verre », Barlow / Barlow Condensed).
- `js/main.js` : année du footer + filtre frise ↔ cartes (auto-détection via `data-experience`).
- `js/chatbot.js` : lanceur/panneau, rendu markdown, cooldown 3 s ; `AVATAR` / `AVATAR_LABEL` en tête.
- `js/config.js` : `chatWorkerUrl` (vide = chatbot désactivé).
- `worker/worker.js` : `SYSTEM_PROMPT` = base de connaissances de Happy ; CORS via `ALLOWED_ORIGIN` ; limite 10 req/60 s par IP.

## Règles de contenu
- Frise : du plus récent au plus ancien ; icônes `#icon-wrench` (travail), `#icon-book` (formation), `#icon-sparkle` (centres d'intérêt).
- Le slug `data-experience` d'une étape doit correspondre caractère pour caractère à celui de ses cartes ; `tabindex="0"` seulement si l'étape a ≥1 carte.
- Si le chatbot est renommé, mettre à jour : `js/chatbot.js`, le HTML (lanceur, panneau, salutation, nudge) et `SYSTEM_PROMPT`.
- Ne jamais publier l'adresse postale ni le téléphone (seul l'e-mail est public).
- `raw.jpg` (photo source) est ignorée par git ; seule `assets/portrait.jpg` est versionnée.

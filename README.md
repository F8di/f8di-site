# f8di.com

Personal site for Fadi, deployed on Cloudflare Pages.

## Structure

```
.
├── index.html            # the site itself
└── functions/
    └── contact.js        # Pages Function — handles POST /contact,
                           # forwards messages to a Discord webhook server-side
```

The contact form posts to `/contact` (same origin, so no CORS issues). The
Pages Function reads your Discord webhook URL from an environment variable
called `DISCORD_WEBHOOK_URL` rather than having it hardcoded in the code —
that keeps it out of your GitHub repo.

## Deploy steps

### 1. Push this to GitHub

```bash
git init
git add .
git commit -m "Initial site"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Connect it to Cloudflare Pages

1. Go to the Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Pick this repo
3. Build settings: leave **Framework preset** as "None" — there's no build step, it's a static file. Build command can stay empty, output directory `/`
4. Deploy

### 3. Add the webhook secret

Cloudflare won't know your Discord webhook URL until you tell it:

1. In the Pages project → **Settings** → **Environment variables**
2. Add a variable named `DISCORD_WEBHOOK_URL`, value = your Discord webhook URL, and mark it **Encrypt** (this makes it a secret)
3. Add it for both **Production** and **Preview** environments
4. Redeploy (Cloudflare needs a fresh deploy to pick up new env vars — you can trigger this from the Deployments tab)

### 4. Point your domain at it

In the Pages project → **Custom domains** → add `f8di.com`, then follow Cloudflare's DNS instructions (this is quick if the domain is already on Cloudflare, otherwise it'll walk you through changing nameservers).

## Local testing

You can test the Function locally with Wrangler:

```bash
npm install -g wrangler
wrangler pages dev . --binding DISCORD_WEBHOOK_URL=your_webhook_url_here
```

Then open the local URL it gives you — the contact form will hit your real webhook, so use a test channel while trying this out.

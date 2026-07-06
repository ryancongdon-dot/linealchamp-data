# linealchamp-api Worker

This directory is the new home of the Worker code that currently lives only
in the Cloudflare dashboard editor.

## One-time migration (from your phone is fine)

1. In the Cloudflare dashboard, open the Worker → **Edit code**, select all
   of `worker.js`, and copy it.
2. On github.com: this repo → **Add file → Create new file** → name it
   `worker/worker.js` → paste → commit. (Or paste it into a Claude session
   and it'll be committed for you.)
3. Fill in the KV namespace ID in `wrangler.toml` (see comments there).
4. Add two repo secrets under Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com → My Profile →
     API Tokens → Create Token → "Edit Cloudflare Workers" template.
   - `CLOUDFLARE_ACCOUNT_ID` — shown on the Workers & Pages overview page.

From then on, any push to `main` that touches `worker/` deploys
automatically, and the dashboard editor never needs to be opened again.
The deploy also pins the cron trigger to hourly, which keeps KV writes a
tenth of the free-tier daily limit.

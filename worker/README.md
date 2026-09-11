# Liftee auth broker

A small Cloudflare Worker that keeps you signed in to Liftee across page
reloads — including on iPhone Safari, where the app's previous approach
(a silent, in-browser token refresh) gets blocked by Safari's tracking
protection.

It only ever handles Google's OAuth tokens — it never sees your workout
data. Your browser still talks to Google Sheets/Drive directly, exactly
like before; this Worker's only job is to hand it a fresh access token
when needed.

Setup takes about 10 minutes and is entirely free (Cloudflare's free tier
is far more than this app will ever use).

## 1. Add a Client Secret to your Google OAuth Client

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Click the OAuth 2.0 Client ID already used by the app (the one matching
   `GOOGLE_CLIENT_ID` in `index.html` / `wrangler.toml`).
3. Under **Client secrets**, click **Add secret** (or copy the existing one
   if it already has one). Copy the secret value — you'll need it in step 4.
4. Under **Authorized redirect URIs**, click **Add URI** and add:
   ```
   https://liftee-auth.YOUR-SUBDOMAIN.workers.dev/callback
   ```
   You won't know your exact `.workers.dev` subdomain until after your first
   deploy in step 3 below — come back and add the real URL then. (You can
   save a placeholder now and edit it after.)
5. Save.

## 2. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```
This opens a browser tab to connect Wrangler to your (free) Cloudflare
account — sign up first at [cloudflare.com](https://dash.cloudflare.com/sign-up)
if you don't have one.

## 3. Create the KV namespace and deploy

```bash
cd worker
wrangler kv namespace create SESSIONS
```
This prints something like:
```
{ binding = "SESSIONS", id = "abcd1234..." }
```
Copy that `id` into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Set the client secret (from step 1) as a Worker secret — never put this in
`wrangler.toml` or commit it:
```bash
wrangler secret put GOOGLE_CLIENT_SECRET
```
(paste the secret when prompted)

Deploy:
```bash
wrangler deploy
```
This prints your Worker's live URL, e.g. `https://liftee-auth.yourname.workers.dev`.

## 4. Wire the real URLs together

Now that you know your Worker's URL:

1. In `worker/wrangler.toml`, set `WORKER_URL` to that exact URL (no
   trailing slash), then run `wrangler deploy` again so the Worker knows
   its own address.
2. Back in Google Cloud Console (step 1.4), replace the placeholder
   redirect URI with the real one: `<your-worker-url>/callback`.
3. In `index.html`, set `AUTH_WORKER_URL` (near `GOOGLE_CLIENT_ID` at the
   top of the `<script>`) to your Worker's URL, then commit and push.

## 5. Confirm `FRONTEND_URL`

`wrangler.toml`'s `FRONTEND_URL` should already match your GitHub Pages
URL. If you use a custom domain for the site instead of the default
`*.github.io` address, update it (and redeploy) to match.

## That's it

Sign in once from the app — you'll see Google's consent screen (this
happens on every explicit sign-in, by design, so a refresh token is
reliably issued). After that, the app stays signed in across reloads,
browser restarts, and Safari's tracking prevention, until you tap
**Sign out**.

## If something goes wrong

- **"Backend not configured yet"** in the app: `AUTH_WORKER_URL` in
  `index.html` still has its placeholder value.
- **`redirect_uri_mismatch` from Google**: the URI in Google Cloud Console
  doesn't exactly match `WORKER_URL + "/callback"` — check for a trailing
  slash or `http` vs `https` mismatch.
- **Signed in, but reload still shows the login screen**: open your
  browser's dev tools console for an error, and check `wrangler tail`
  (run in the `worker/` directory) to see the Worker's own logs while you
  reproduce it.

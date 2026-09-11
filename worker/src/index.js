/*
 * Liftee auth broker — a small Cloudflare Worker that holds the Google OAuth
 * refresh token server-side and mints short-lived access tokens on request.
 *
 * It never sees your workout data — only Google's OAuth tokens. The browser
 * still talks to Google Sheets/Drive directly with the access token this
 * Worker hands it, exactly as before.
 *
 * Routes:
 *   GET  /callback  — Google redirects here after consent; exchanges the
 *                      code for tokens, stores the refresh token in KV under
 *                      a new opaque session id, redirects back to the app.
 *   POST /token      — { Authorization: Bearer <session_id> } -> a fresh
 *                      { access_token, expires_in }.
 *   POST /revoke     — { Authorization: Bearer <session_id> } -> deletes the
 *                      session and revokes the refresh token with Google.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/callback' && request.method === 'GET') {
        return await handleCallback(url, env);
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        return withCors(await handleToken(request, env));
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        return withCors(await handleRevoke(request, env));
      }
    } catch (err) {
      return withCors(jsonResponse({ error: 'internal_error', message: String(err) }, 500));
    }

    return new Response('Not found', { status: 404 });
  },
};

function withCors(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getBearerSessionId(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function frontendUrl(env) {
  return env.FRONTEND_URL.replace(/\/+$/, '');
}

function workerCallbackUrl(env) {
  return env.WORKER_URL.replace(/\/+$/, '') + '/callback';
}

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error');
  const frontend = frontendUrl(env);

  if (error || !code) {
    return Response.redirect(`${frontend}/#auth_error=${encodeURIComponent(error || 'missing_code')}`, 302);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: workerCallbackUrl(env),
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.refresh_token) {
    const reason = tokenData.error || 'token_exchange_failed';
    return Response.redirect(`${frontend}/#auth_error=${encodeURIComponent(reason)}`, 302);
  }

  const sessionId = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify({ refresh_token: tokenData.refresh_token, created_at: Date.now() })
  );

  return Response.redirect(`${frontend}/#session=${sessionId}&state=${encodeURIComponent(state)}`, 302);
}

async function handleToken(request, env) {
  const sessionId = getBearerSessionId(request);
  if (!sessionId) return jsonResponse({ error: 'missing_session' }, 401);

  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return jsonResponse({ error: 'invalid_session' }, 401);
  const { refresh_token } = JSON.parse(raw);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    // Refresh token is no longer valid (revoked, expired from inactivity) — drop the session.
    await env.SESSIONS.delete(`session:${sessionId}`);
    return jsonResponse({ error: tokenData.error || 'refresh_failed' }, 401);
  }

  return jsonResponse({ access_token: tokenData.access_token, expires_in: tokenData.expires_in });
}

async function handleRevoke(request, env) {
  const sessionId = getBearerSessionId(request);
  if (sessionId) {
    const raw = await env.SESSIONS.get(`session:${sessionId}`);
    if (raw) {
      const { refresh_token } = JSON.parse(raw);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh_token)}`, {
        method: 'POST',
      }).catch(() => {});
    }
    await env.SESSIONS.delete(`session:${sessionId}`);
  }
  return new Response(null, { status: 204 });
}

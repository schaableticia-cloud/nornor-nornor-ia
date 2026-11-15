/**
 * Puente IA 2: Cloudflare Worker, same-origin static site + server-side public Roblox lookup.
 * AI messages use an OpenAI API key kept exclusively in server environment secrets.
 * No ChatGPT account login or Roblox account ownership is claimed here.
 */
const json = (data, status = 200, more = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...more
  }
});
function timeoutFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(9000) });
}
async function robloxSearch(req) {
  const params = new URL(req.url).searchParams;
  const q = (params.get('query') || '').trim();
  const cursor = (params.get('cursor') || '').trim();
  if (q.length < 2 || q.length > 60 || cursor.length > 500) {
    return json({ error: 'Ingresá entre 2 y 60 caracteres.' }, 400);
  }
  const search = new URL('https://users.roblox.com/v1/users/search');
  search.searchParams.set('keyword', q);
  search.searchParams.set('limit', '25');
  if (cursor) search.searchParams.set('cursor', cursor);
  try {
    const result = await timeoutFetch(search.toString(), { headers: { accept: 'application/json' } });
    if (result.status === 429) return json({ error: 'Roblox está limitando las búsquedas. Probá de nuevo más tarde.' }, 429);
    if (!result.ok) return json({ error: `Roblox no respondió correctamente (${result.status}).` }, 502);
    const raw = await result.json();
    const data = Array.isArray(raw.data) ? raw.data.slice(0, 25) : [];
    const ids = data.map(user => Number(user.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    let avatarUrls = new Map();
    if (ids.length) {
      const avatars = new URL('https://thumbnails.roblox.com/v1/users/avatar-headshot');
      avatars.searchParams.set('userIds', ids.join(','));
      avatars.searchParams.set('size', '150x150');
      avatars.searchParams.set('format', 'Png');
      avatars.searchParams.set('isCircular', 'false');
      try {
        const ar = await timeoutFetch(avatars.toString(), { headers: { accept: 'application/json' } });
        if (ar.ok) {
          const entries = (await ar.json()).data || [];
          avatarUrls = new Map(entries.map(x => {
            const imageUrl = typeof x.imageUrl === 'string' && /^https:\/\/[a-z0-9.-]*rbxcdn\.com\//i.test(x.imageUrl) ? x.imageUrl : null;
            return [Number(x.targetId), imageUrl];
          }));
        }
      } catch (_) { /* Can still show profiles without avatar if thumbnails service fails. */ }
    }
    const users = data.filter(x => Number.isSafeInteger(Number(x.id)) && Number(x.id) > 0)
      .map(user => ({
        id: Number(user.id),
        username: String(user.name || '').slice(0, 80),
        displayName: String(user.displayName || user.name || '').slice(0, 80),
        avatar: avatarUrls.get(Number(user.id)) || null,
        verified: Boolean(user.hasVerifiedBadge),
        profileUrl: `https://www.roblox.com/users/${Number(user.id)}/profile`
      }));
    return json({ users, nextCursor: typeof raw.nextPageCursor === 'string' ? raw.nextPageCursor : null,
      note: 'Resultados de Roblox, no recuento mundial de todos los nombres de visualización.' });
  } catch (e) {
    return json({ error: 'No se pudo consultar Roblox desde el servidor. Revisá la conexión e intentá otra vez.' }, 502);
  }
}
async function aiChat(req, env) {
  if (!env.OPENAI_API_KEY || !env.APP_ACCESS_CODE) {
    return json({ error: 'El chat con IA todavía no está configurado. El administrador debe cargar OPENAI_API_KEY y APP_ACCESS_CODE en los secretos del Worker.' }, 503);
  }
  if (req.headers.get('x-app-access-code') !== env.APP_ACCESS_CODE) return json({ error: 'Código de acceso incorrecto.' }, 401);
  if (Number(req.headers.get('content-length') || 0) > 14000) return json({ error: 'Mensaje demasiado largo.' }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Solicitud inválida.' }, 400); }
  const message = String(body.message || '').trim();
  if (!message || message.length > 2200) return json({ error: 'El mensaje debe contener entre 1 y 2200 caracteres.' }, 400);
  const u = body.profile && typeof body.profile === 'object' ? body.profile : null;
  const profile = u && Number.isSafeInteger(Number(u.id)) ? {
    id: Number(u.id),
    displayName: String(u.displayName || '').slice(0, 80),
    username: String(u.username || '').slice(0, 80),
  } : null;
  const prefix = profile ? `Perfil público seleccionado en Roblox: ID ${profile.id}, nombre visible ${profile.displayName}, usuario ${profile.username}. No presupongas que la persona que consulta es dueña de este perfil. ` : '';
  try {
    const ai = await timeoutFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4.1-mini',
        store: false,
        max_output_tokens: 650,
        instructions: 'Respondé en español rioplatense con claridad. No afirmes tener acceso ni control de cuentas Roblox, ChatGPT u Opera. No afirmes conocer datos privados. No ejecutás acciones en plataformas: sólo ofrecés información y ayuda basadas en los datos aportados.',
        input: prefix + message
      })
    });
    if (!ai.ok) {
      if (ai.status === 429) return json({ error: 'La IA está ocupada o se llegó al límite de uso.' }, 429);
      return json({ error: `La API de OpenAI respondió ${ai.status}. Revisá la clave, el modelo y los créditos.` }, 502);
    }
    const output = await ai.json();
    const reply = (output.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text || '').join('\n').trim();
    return json({ reply: reply || 'La IA no devolvió texto.' });
  } catch {
    return json({ error: 'No se pudo completar la consulta con OpenAI.' }, 502);
  }
}
// Roblox OAuth 2.0: identity only, with server-held secret, PKCE and signed cookies.
// Only a registered Roblox app can use this; never accept passwords or cookies from users.
const encoder = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
const randomToken = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(a); };
async function signature(content, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(content))));
}
async function signJson(data, secret) {
  const value = b64u(encoder.encode(JSON.stringify(data)));
  return value + '.' + await signature(value, secret);
}
async function readSigned(value, secret) {
  if (!value || value.length > 2400 || !secret) return null;
  const at = value.lastIndexOf('.');
  if (at < 0) return null;
  const data = value.slice(0, at), mac = value.slice(at + 1);
  const expected = await signature(data, secret);
  // Compare all positions without shortcut so invalid signatures do not short-circuit.
  if (mac.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return null;
  try { return JSON.parse(new TextDecoder().decode(fromB64u(data))); } catch { return null; }
}
function cookies(request) {
  const all = Object.create(null);
  for (const entry of (request.headers.get('cookie') || '').split(';')) {
    const index = entry.indexOf('=');
    if (index > 0) all[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return all;
}
function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const oauthConfigured = env => Boolean(env.ROBLOX_CLIENT_ID && env.ROBLOX_CLIENT_SECRET && env.AUTH_SESSION_SECRET && env.AUTH_SESSION_SECRET.length >= 32);
function plainPage(message, status=400) {
  const clean = String(message).replace(/[<>&"']/g, '');
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Puente IA</title><body style="font-family:system-ui;padding:3rem;background:#17132d;color:#fff"><h1>Puente IA</h1><p>${clean}</p><a style="color:#ac9afa" href="/">Volver al inicio</a></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }});
}
async function oauthStart(request, env) {
  if (!oauthConfigured(env)) return plainPage('La vinculación de Roblox todavía no fue configurada por el administrador.', 503);
  const origin = new URL(request.url).origin;
  const state = randomToken(20), verifier = randomToken(32), nonce = randomToken(20);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const destination = new URL('https://apis.roblox.com/oauth/v1/authorize');
  destination.searchParams.set('client_id', env.ROBLOX_CLIENT_ID);
  destination.searchParams.set('redirect_uri', origin + '/api/roblox/auth/callback');
  destination.searchParams.set('scope', 'openid profile');
  destination.searchParams.set('response_type', 'code');
  destination.searchParams.set('code_challenge', b64u(digest));
  destination.searchParams.set('code_challenge_method', 'S256');
  destination.searchParams.set('state', state);
  destination.searchParams.set('nonce', nonce);
  const flow = await signJson({ state, verifier, nonce, created: Date.now() }, env.AUTH_SESSION_SECRET);
  return new Response(null, {status: 302, headers: {
    location: destination.toString(),
    'set-cookie': setCookie('pi_oauth_flow', flow, 300),
    'cache-control': 'no-store'
  }});
}
async function oauthCallback(request, env) {
  const url = new URL(request.url);
  if (!oauthConfigured(env)) return plainPage('La vinculación todavía no está configurada.', 503);
  if (url.searchParams.has('error')) return plainPage('Roblox no autorizó la conexión. Podés volver a intentarlo.');
  const code = url.searchParams.get('code'), receivedState = url.searchParams.get('state');
  const flow = await readSigned(cookies(request).pi_oauth_flow, env.AUTH_SESSION_SECRET);
  if (!flow || !code || !receivedState || flow.state !== receivedState || Date.now()-flow.created > 300000 || flow.created > Date.now()+10000) {
    return plainPage('La autorización venció o es inválida. Volvé a iniciar la conexión.');
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      client_id: env.ROBLOX_CLIENT_ID,
      client_secret: env.ROBLOX_CLIENT_SECRET,
      redirect_uri: url.origin + '/api/roblox/auth/callback'
    });
    const exchange = await timeoutFetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST', headers: {'content-type':'application/x-www-form-urlencoded'}, body: params.toString()
    });
    if (!exchange.ok) return plainPage('Roblox rechazó el intercambio de autorización. Revisá el registro de la aplicación.');
    const token = await exchange.json();
    if (!token.access_token) return plainPage('Roblox no devolvió una autorización válida.');
    const userResponse = await timeoutFetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: {authorization: 'Bearer ' + token.access_token, accept: 'application/json'}
    });
    if (!userResponse.ok) return plainPage('No se pudo verificar la identidad con Roblox.');
    const details = await userResponse.json();
    const id = Number(details.sub);
    if (!Number.isSafeInteger(id) || id <= 0) return plainPage('No se pudo identificar la cuenta de Roblox.');
    const user = {
      id,
      username: String(details.preferred_username || '').slice(0, 80),
      displayName: String(details.name || details.nickname || '').slice(0, 80),
      avatar: typeof details.picture === 'string' && /^https:\/\/[a-z0-9.-]*rbxcdn\.com\//i.test(details.picture) ? details.picture : null,
      profileUrl: `https://www.roblox.com/users/${id}/profile`
    };
    const session = await signJson({ user, until: Date.now() + 12*60*60*1000 }, env.AUTH_SESSION_SECRET);
    const headers = new Headers({location:'/#conexion', 'cache-control':'no-store'});
    headers.append('set-cookie',setCookie('pi_oauth_flow','',0));
    headers.append('set-cookie',setCookie('pi_roblox_session',session,12*60*60));
    return new Response(null,{status:302,headers});
  } catch { return plainPage('No se pudo completar la conexión con Roblox. Intentá nuevamente.'); }
}
async function oauthStatus(request, env) {
  if (!oauthConfigured(env)) return json({configured:false, connected:false});
  const session = await readSigned(cookies(request).pi_roblox_session, env.AUTH_SESSION_SECRET);
  const connected = Boolean(session && session.until > Date.now() && session.user && Number.isSafeInteger(session.user.id));
  return json({ configured:true, connected, user:connected?session.user:null });
}
function oauthLogout() {
  return new Response(null,{status:204,headers:{'set-cookie':setCookie('pi_roblox_session','',0),'cache-control':'no-store'}});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/roblox/auth/start' && request.method === 'GET') return oauthStart(request, env);
    if (url.pathname === '/api/roblox/auth/callback' && request.method === 'GET') return oauthCallback(request, env);
    if (url.pathname === '/api/roblox/auth/status' && request.method === 'GET') return oauthStatus(request, env);
    if (url.pathname === '/api/roblox/auth/logout' && request.method === 'POST') return oauthLogout();
    if (url.pathname === '/api/roblox/search') {
      if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
      return robloxSearch(request);
    }
    if (url.pathname === '/api/ai/chat') {
      if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
      return aiChat(request, env);
    }
    if (url.pathname === '/api/health') return json({ ok: true, robloxSearch: true, robloxOauthConfigured: oauthConfigured(env), aiConfigured: Boolean(env.OPENAI_API_KEY && env.APP_ACCESS_CODE) });
    if (url.pathname.startsWith('/api/')) return json({ error: 'Ruta inexistente.' }, 404);
    return env.ASSETS.fetch(request);
  }
};

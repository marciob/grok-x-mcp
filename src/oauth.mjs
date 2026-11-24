// OAuth 2.1 in front of the MCP server, for a chat product that accepts no
// fixed token, such as the Gemini app on the web. The product registers
// itself (RFC 7591), sends the owner to an approval page of this server, and
// trades a code for a token, with PKCE (RFC 7636). The discovery documents
// answer at the route and at the root with the route after them (RFC 8414,
// RFC 9728), because clients ask for both.
//
// Only the owner approves a connection: the page asks for the approval
// secret. A person who has the address and not that secret gets no token.
// The approval secret is not a bearer token: it opens the approval page and
// nothing else.
//
// Adapted from openmsg (src/oauth.mjs), with these changes: a list of allowed
// redirect hosts, short access tokens, detection of a reused refresh token,
// removal of clients that the owner never approved, and stores with no
// prototype.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CODE_MS = 5 * 60_000;
const ACCESS_MS = 3_600_000;
const REFRESH_MS = 30 * 24 * 3_600_000;
const UNAPPROVED_MS = 3_600_000;
const MAX_APPROVED = 20;
const MAX_PENDING = 10;
const SLOW_AFTER = 10;
const SCOPE = "x";

// The hosts that Gemini registers (seen live), plus Claude and local clients.
export const DEFAULT_REDIRECT_HOSTS = [
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
  "claude.ai",
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
];

const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const sameText = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const bare = (o = {}) => Object.assign(Object.create(null), o);
const has = (o, k) => typeof k === "string" && Object.hasOwn(o, k);

// `redirectHosts`: a list of host names, or ["*"] for any https host.
export function createOAuth({ approvalSecret, publicUrl, route, file, redirectHosts = DEFAULT_REDIRECT_HOSTS, title = "Grok X MCP", now = () => Date.now(), log = () => {} }) {
  if (typeof approvalSecret !== "string" || approvalSecret.length < 16) throw new Error("the approval secret needs 16 characters or more");
  const base = new URL(publicUrl);
  const local = (h) => h === "127.0.0.1" || h === "localhost";
  if (base.protocol !== "https:" && !local(base.hostname)) throw new Error("PUBLIC_URL must start with https://");
  const issuer = publicUrl.replace(/\/+$/, "");
  const at = (p) => `${issuer}${p}`;
  const anyHost = redirectHosts.includes("*");

  // Clients and tokens survive a restart. A token is kept as its digest, so
  // the file gives no token that works.
  // The command `grok-x-mcp revoke` edits the same file while the server
  // runs, so the server reads the file again when its time of change moves.
  const store = { clients: bare(), access: bare(), refresh: bare(), used: bare() };
  let seen = 0;
  const mtime = () => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  const load = () => {
    const m = mtime();
    if (m === seen) return;
    seen = m;
    for (const k of Object.keys(store)) store[k] = bare();
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of Object.keys(store)) if (saved[k] && typeof saved[k] === "object") store[k] = bare(saved[k]);
    } catch {
      // No file yet.
    }
  };
  load();
  const save = () => {
    const t = now();
    for (const kind of ["access", "refresh", "used"]) {
      for (const [k, v] of Object.entries(store[kind])) if (v.exp < t) delete store[kind][k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    seen = mtime();
  };
  const codes = new Map();
  let tries = [];

  const metadata = {
    issuer,
    authorization_endpoint: at("/oauth/authorize"),
    token_endpoint: at("/oauth/token"),
    registration_endpoint: at("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
  };
  const resource = {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: title,
  };
  const resourceMetadataUrl = at("/.well-known/oauth-protected-resource");

  const wellKnown = {
    [`${route}/.well-known/oauth-protected-resource`]: resource,
    [`/.well-known/oauth-protected-resource${route}`]: resource,
    [`${route}/.well-known/oauth-authorization-server`]: metadata,
    [`/.well-known/oauth-authorization-server${route}`]: metadata,
    [`${route}/.well-known/openid-configuration`]: metadata,
    [`/.well-known/openid-configuration${route}`]: metadata,
  };

  // Returns the client id of a valid access token, or null.
  function validToken(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? ""));
    if (!m) return null;
    load();
    const key = hash(m[1]);
    const row = has(store.access, key) ? store.access[key] : null;
    return row && row.exp > now() && has(store.clients, row.client) ? row.client : null;
  }

  function handles(pathname) {
    return Object.hasOwn(wellKnown, pathname) || pathname.startsWith(`${route}/oauth/`);
  }

  // `send(code, body, headers)` writes JSON. `html(code, text)` writes a page.
  async function handle(req, pathname, body, { send, html, redirect, pause }) {
    load();
    if (Object.hasOwn(wellKnown, pathname)) {
      if (req.method !== "GET") return send(405, null, { allow: "GET" });
      return send(200, wellKnown[pathname], { "access-control-allow-origin": "*" });
    }
    const op = pathname.slice(`${route}/oauth/`.length);
    if (op === "register") return register(req, body, send);
    if (op === "authorize") return authorize(req, body, { send, html, redirect, pause });
    if (op === "token") return token(req, body, { send, pause });
    return send(404);
  }

  function allowedRedirect(u) {
    if (typeof u !== "string") return false;
    let url;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    if (local(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
    if (url.protocol !== "https:") return false;
    return anyHost || redirectHosts.includes(url.hostname);
  }

  function pruneClients() {
    const t = now();
    for (const [id, c] of Object.entries(store.clients)) {
      if (!c.approved && t - Date.parse(c.at) > UNAPPROVED_MS) delete store.clients[id];
    }
  }

  function register(req, body, send) {
    if (req.method !== "POST") return send(405, null, { allow: "POST" });
    let meta;
    try {
      meta = JSON.parse(body || "{}");
    } catch {
      return send(400, { error: "invalid_client_metadata", error_description: "the body is not JSON" });
    }
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    if (uris.length === 0 || uris.length > 16 || !uris.every(allowedRedirect)) {
      log(`refused a registration: redirect host not allowed`);
      return send(400, {
        error: "invalid_redirect_uri",
        error_description: "each redirect_uri must be https on an allowed host. The owner sets the hosts in ALLOWED_REDIRECT_HOSTS.",
      });
    }
    // Registration needs no auth, so a stranger can register too. Clients
    // that the owner never approved go after one hour, and the oldest of them
    // goes when there are too many. Approved clients are never pushed out.
    pruneClients();
    const all = Object.entries(store.clients);
    if (all.filter(([, c]) => c.approved).length >= MAX_APPROVED) {
      return send(400, { error: "invalid_client_metadata", error_description: "this server holds the most clients that it takes. The owner runs: grok-x-mcp revoke <id>" });
    }
    const pending = all.filter(([, c]) => !c.approved).sort((a, b) => a[1].at.localeCompare(b[1].at));
    while (pending.length >= MAX_PENDING) delete store.clients[pending.shift()[0]];
    const method = ["client_secret_post", "client_secret_basic"].includes(meta.token_endpoint_auth_method) ? meta.token_endpoint_auth_method : "none";
    const id = `c_${random(12)}`;
    const secret = method === "none" ? null : random(32);
    store.clients[id] = {
      name: String(meta.client_name ?? "a client").slice(0, 80),
      redirectUris: uris,
      method,
      secret: secret ? hash(secret) : null,
      approved: false,
      at: new Date(now()).toISOString(),
    };
    save();
    log(`registered the client ${id} (${store.clients[id].name})`);
    return send(201, {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: store.clients[id].name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    });
  }

  function page(params, error = null) {
    const client = store.clients[params.client_id];
    const host = new URL(params.redirect_uri).host;
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
      .map((k) => `<input type="hidden" name="${k}" value="${escape(params[k] ?? "")}">`)
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}: approve a connection</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem}
.err{color:#b00020}code{background:#eee;padding:0 .3rem}</style></head><body>
<h1>Approve a connection</h1>
<p><strong>${escape(client.name)}</strong> asks for access to <code>${escape(title)}</code>. After the approval, it can search X through your Grok Bot routine. Each search uses your Grok Bot usage.</p>
<p>After the approval, the browser goes to <code>${escape(host)}</code>. Approve only if you started this connection there.</p>
${error ? `<p class="err">${escape(error)}</p>` : ""}
<form method="post">${hidden}
<label for="s">Approval secret of this server</label>
<input id="s" name="approval_secret" type="password" autocomplete="off" required autofocus>
<button type="submit">Approve</button></form></body></html>`;
  }

  async function authorize(req, body, { send, html, redirect, pause }) {
    const params = req.method === "POST" ? Object.fromEntries(new URLSearchParams(body)) : Object.fromEntries(new URL(req.url, "http://local").searchParams);
    const client = has(store.clients, params.client_id) ? store.clients[params.client_id] : null;
    // With no known client or no known address, the page sends nobody back,
    // because the address could belong to an attacker.
    if (!client) return html(400, "<p>Unknown client. Register it first.</p>");
    if (!client.redirectUris.includes(params.redirect_uri)) return html(400, "<p>That redirect_uri is not registered for this client.</p>");
    // Before the approval, an error shows a page and sends nobody to the
    // redirect address, so this server is no open redirect.
    const back = (query) => {
      const u = new URL(params.redirect_uri);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      if (params.state) u.searchParams.set("state", params.state);
      return redirect(u.toString());
    };
    if (req.method === "GET" && (params.response_type ?? "code") !== "code") return html(400, "<p>Only response_type=code is supported.</p>");
    if (!params.code_challenge || params.code_challenge_method !== "S256") return html(400, "<p>PKCE with S256 is required.</p>");
    if (req.method === "GET") return html(200, page(params));
    if (req.method !== "POST") return send(405, null, { allow: "GET, POST" });

    // The secret is compared first, so wrong tries from a stranger never
    // lock the owner out. Each wrong try waits, and many wrong tries in one
    // minute wait longer. The secret is random, so a guess cannot win.
    const t = now();
    if (!sameText(params.approval_secret ?? "", approvalSecret)) {
      tries = tries.filter((x) => t - x < 60_000);
      tries.push(t);
      await pause(tries.length > SLOW_AFTER ? 3000 : 500);
      log(`refused an approval for ${params.client_id}: wrong secret`);
      return html(401, page(params, "That is not the approval secret. Try again."));
    }
    for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
    const code = random(32);
    codes.set(hash(code), { client: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, exp: t + CODE_MS });
    client.approved = true;
    save();
    log(`the owner approved the client ${params.client_id} (${client.name})`);
    return back({ code });
  }

  function clientOf(req, params) {
    let id = params.client_id;
    let secret = params.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    if (basic) {
      const raw = Buffer.from(basic[1], "base64").toString("utf8");
      const at = raw.indexOf(":");
      try {
        id = decodeURIComponent(at === -1 ? raw : raw.slice(0, at));
        secret = decodeURIComponent(at === -1 ? "" : raw.slice(at + 1));
      } catch {
        return null;
      }
    }
    if (!has(store.clients, id)) return null;
    const client = store.clients[id];
    if (client.secret && !(secret && sameText(hash(secret), client.secret))) return null;
    return { id, client };
  }

  function issue(clientId) {
    const access = random(32);
    const refresh = random(32);
    const t = now();
    store.access[hash(access)] = { client: clientId, exp: t + ACCESS_MS };
    store.refresh[hash(refresh)] = { client: clientId, exp: t + REFRESH_MS };
    save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  function dropTokens(clientId) {
    for (const kind of ["access", "refresh"]) {
      for (const [k, v] of Object.entries(store[kind])) if (v.client === clientId) delete store[kind][k];
    }
  }

  async function token(req, body, { send, pause }) {
    if (req.method !== "POST") return send(405, null, { allow: "POST" });
    const type = String(req.headers["content-type"] ?? "");
    let params = {};
    try {
      params = type.includes("application/json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body));
    } catch {
      return send(400, { error: "invalid_request" });
    }
    const cors = { "access-control-allow-origin": "*" };
    const who = clientOf(req, params);
    if (!who) {
      await pause(300);
      return send(401, { error: "invalid_client" }, cors);
    }
    if (params.grant_type === "authorization_code") {
      const key = hash(params.code ?? "");
      const row = codes.get(key);
      codes.delete(key);
      const challenge = crypto.createHash("sha256").update(String(params.code_verifier ?? "")).digest("base64url");
      if (!row || row.exp < now() || row.client !== who.id || row.redirectUri !== params.redirect_uri || !sameText(challenge, row.challenge)) {
        await pause(300);
        return send(400, { error: "invalid_grant" }, cors);
      }
      log(`gave a token to the client ${who.id}`);
      return send(200, issue(who.id), cors);
    }
    if (params.grant_type === "refresh_token") {
      const key = hash(params.refresh_token ?? "");
      // A refresh token that was used before means that two parties hold it.
      // All tokens of that client stop, and the owner approves it again.
      if (has(store.used, key) && store.used[key].client === who.id) {
        dropTokens(who.id);
        save();
        log(`a used refresh token came back for ${who.id}: revoked all its tokens`);
        await pause(300);
        return send(400, { error: "invalid_grant" }, cors);
      }
      const row = has(store.refresh, key) ? store.refresh[key] : null;
      if (!row || row.exp < now() || row.client !== who.id) {
        await pause(300);
        return send(400, { error: "invalid_grant" }, cors);
      }
      delete store.refresh[key];
      store.used[key] = { client: who.id, exp: row.exp };
      return send(200, issue(who.id), cors);
    }
    return send(400, { error: "unsupported_grant_type" }, cors);
  }

  function revoke(clientId) {
    load();
    if (clientId === "all") {
      for (const k of Object.keys(store)) store[k] = bare();
      save();
      return true;
    }
    if (!has(store.clients, clientId)) return false;
    dropTokens(clientId);
    delete store.clients[clientId];
    save();
    return true;
  }

  function clients() {
    load();
    return Object.entries(store.clients).map(([id, c]) => ({ id, name: c.name, approved: c.approved, at: c.at, redirectHosts: [...new Set(c.redirectUris.map((u) => new URL(u).host))] }));
  }

  return { handles, handle, validToken, resourceMetadataUrl, revoke, clients, metadata };
}

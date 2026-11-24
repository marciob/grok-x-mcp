// The MCP server over HTTP. One POST carries one JSON-RPC message, and the
// answer is one JSON object. The server keeps no session, so it gives no
// session id and no stream. Web clients need no more than that.
//
// The address is public, because a tunnel or a proxy in front gives it to the
// internet. A request with no valid token gets 401 before the server reads
// its body. The listener stays on the loopback address by default, and the
// proxy in front ends TLS.
import http from "node:http";
import crypto from "node:crypto";

export const MAX_HTTP_BODY = 4 * 1024 * 1024;
// The OAuth paths take no auth, so their bodies stay small.
export const MAX_OAUTH_BODY = 16 * 1024;
export const MIN_TOKEN = 32;

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// `server`: the object of createServer in rpc.mjs.
// `adminToken`: an optional fixed bearer token, for curl and for clients that
// take a header. `oauth`: the object of createOAuth, for clients that do not.
// `hooks`: extra paths with no bearer token, such as the callback of the
// Grok Bot routine: { "/path": async ({ method, url, body }) => ({ status, body }) }.
// Each hook checks its own secret.
export const MAX_HOOK_BODY = 2 * 1024 * 1024;
export function serveHttp({ server, adminToken = null, oauth = null, route, hooks = {}, port = 0, host = "127.0.0.1", log = () => {} }) {
  if (adminToken !== null && (typeof adminToken !== "string" || adminToken.length < MIN_TOKEN)) {
    throw new Error(`ADMIN_TOKEN needs ${MIN_TOKEN} characters or more`);
  }
  if (!adminToken && !oauth) throw new Error("give an admin token, OAuth, or both");
  // Two digests of one length compare in constant time, whatever the length
  // of the header that arrived.
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  const expected = adminToken ? digest(`Bearer ${adminToken}`) : null;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  const readBody = async (req, limit) => {
    if (Number(req.headers["content-length"]) > limit) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const listener = http.createServer(async (req, res) => {
    const began = Date.now();
    const send = (code, body = null, headers = {}) => {
      const out = body === null ? "" : JSON.stringify(body);
      res.writeHead(code, { ...(body === null ? {} : { "content-type": "application/json" }), "content-length": Buffer.byteLength(out), "cache-control": "no-store", ...headers });
      res.end(out);
    };
    const html = (code, page) => {
      res.writeHead(code, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(page),
        "cache-control": "no-store",
        // No other site can put the page in a frame and take the click of
        // the owner.
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      });
      res.end(page);
    };
    const redirect = (to) => {
      res.writeHead(302, { location: to, "cache-control": "no-store", "content-length": 0 });
      res.end();
    };
    try {
      const pathname = new URL(req.url, "http://local").pathname;
      if (oauth && oauth.handles(pathname)) {
        const body = await readBody(req, MAX_OAUTH_BODY);
        if (body === null) return send(413, { error: "the body is too big" }, { connection: "close" });
        await oauth.handle(req, pathname, body, { send, html, redirect, pause });
        log(`${req.method} oauth${pathname.slice(pathname.lastIndexOf("/"))} ${res.statusCode} in ${Date.now() - began} ms`);
        return;
      }
      if (Object.hasOwn(hooks, pathname)) {
        if (req.method !== "POST") return send(405, null, { allow: "POST" });
        const body = await readBody(req, MAX_HOOK_BODY);
        if (body === null) return send(413, { error: "the body is too big" }, { connection: "close" });
        const out = await hooks[pathname]({ method: req.method, url: new URL(req.url, "http://local"), body });
        log(`POST hook${pathname.slice(pathname.lastIndexOf("/"))} ${out.status} in ${Date.now() - began} ms`);
        return send(out.status, out.body ?? null);
      }
      if (pathname !== route) {
        // The path tells which address a client expected. It holds no secret
        // of the client, only the route, which the log holds already.
        log(`${req.method} ${pathname.slice(0, 200)} 404`);
        return send(404);
      }
      const header = String(req.headers.authorization ?? "");
      const fixed = expected ? crypto.timingSafeEqual(digest(header), expected) : false;
      const client = fixed ? "admin" : oauth ? oauth.validToken(header) : null;
      if (!client) {
        // A guess costs time, and it learns nothing.
        await pause(300);
        log(`refused a request with no valid token`);
        req.resume();
        const challenge = oauth ? `Bearer resource_metadata="${oauth.resourceMetadataUrl}"` : "Bearer";
        return send(401, { error: "a valid token is required" }, { "www-authenticate": challenge });
      }
      if (req.method !== "POST") return send(405, null, { allow: "POST" });
      const body = await readBody(req, MAX_HTTP_BODY);
      if (body === null) return send(413, { error: "the body is too big" }, { connection: "close" });
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      if (Array.isArray(message)) return send(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "One message for each request" } });
      // The revision 2026-07-28 names the method in a header too, and the two must agree.
      const named = req.headers["mcp-method"];
      if (named !== undefined && named !== message?.method) {
        return send(400, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32020, message: "The Mcp-Method header and the body do not agree" } });
      }
      const answer = await server.handle(message);
      // One line for each request, with no content, so the owner sees who
      // called, what, and how long it took.
      const tool = message?.method === "tools/call" ? ` ${String(message.params?.name ?? "?").slice(0, 60)}` : "";
      const failed = answer?.error ? ` error ${answer.error.code}` : answer?.result?.isError ? ` tool-error (${answer.reason ?? "?"})` : " ok";
      log(`${String(message?.method).slice(0, 60)}${tool}${failed} in ${Date.now() - began} ms (${client})`);
      if (answer === null) return send(202);
      send(200, answer);
    } catch (e) {
      log(`a request failed: ${e.message}`);
      if (!res.headersSent) send(500, { error: "the server failed" });
    }
  });
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => {
      const real = listener.address().port;
      resolve({ port: real, url: `http://${host}:${real}${route}`, close: () => new Promise((done) => {
        listener.close(done);
        listener.closeAllConnections();
      }) });
    });
  });
}

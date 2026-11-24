// Tests for OAuth and the HTTP door: discovery, registration with allowed
// redirect hosts, approval, PKCE, tokens, refresh reuse, revoke. The server
// listens on the loopback address and stops at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createOAuth } from "../src/oauth.mjs";
import { serveHttp, newToken } from "../src/http.mjs";
import { createApp } from "../src/app.mjs";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "grok-x-mcp-oauth-"));
const FILE = path.join(DIR, "oauth.json");
const SECRET = "approval-secret-for-tests-only";
const ADMIN = newToken();
const ROUTE = "/r4nd0m-route";
const PUBLIC = `https://example.test${ROUTE}`;
const REDIRECT = "https://oauth-redirect.googleusercontent.com/r/test";
const logs = [];
const make = () => createOAuth({ approvalSecret: SECRET, publicUrl: PUBLIC, route: ROUTE, file: FILE, log: (l) => logs.push(l) });
const oauth = make();
const { server } = createApp({ config: { routineUrl: "https://routine.test/hook", routineKey: "k", callbackUrl: "https://example.test/cb", maxPerHour: 10 }, fetch: async () => new Response("{}") });
const running = await serveHttp({ server, adminToken: ADMIN, oauth, route: ROUTE, log: (l) => logs.push(l) });
after(async () => {
  await running.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});
const origin = `http://127.0.0.1:${running.port}`;
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const form = (o) => new URLSearchParams(o).toString();
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } };
const callMcp = (token) => fetch(origin + ROUTE, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(init) });
const post = (p, body, type = "application/x-www-form-urlencoded") => fetch(origin + ROUTE + p, { method: "POST", redirect: "manual", headers: { "content-type": type }, body });

let client;
let tokens;

test("no token gives 401 with the discovery address, and the admin token works", async () => {
  const res = await callMcp(null);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
  assert.equal((await callMcp(ADMIN)).status, 200);
  assert.equal((await callMcp("made-up")).status, 401);
});

test("the approval secret is not a bearer token", async () => {
  assert.equal((await callMcp(SECRET)).status, 401);
});

test("the discovery documents answer at the route and at the root", async () => {
  for (const p of [`/.well-known/oauth-protected-resource${ROUTE}`, `${ROUTE}/.well-known/oauth-protected-resource`]) {
    assert.deepEqual((await (await fetch(origin + p)).json()).authorization_servers, [PUBLIC]);
  }
  for (const p of [`${ROUTE}/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server${ROUTE}`, `/.well-known/openid-configuration${ROUTE}`]) {
    const md = await (await fetch(origin + p)).json();
    assert.equal(md.registration_endpoint, `${PUBLIC}/oauth/register`);
  }
});

test("registration takes only allowed redirect hosts", async () => {
  const bad = await post("/oauth/register", JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }), "application/json");
  assert.equal(bad.status, 400);
  const plainHttp = await post("/oauth/register", JSON.stringify({ redirect_uris: ["http://oauth-redirect.googleusercontent.com/r"] }), "application/json");
  assert.equal(plainHttp.status, 400);
  const res = await post("/oauth/register", JSON.stringify({ client_name: "Google", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }), "application/json");
  assert.equal(res.status, 201);
  client = await res.json();
  assert.ok(client.client_secret);
});

test("a client id such as constructor is unknown", async () => {
  const res = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ client_id: "constructor", redirect_uri: REDIRECT })}`);
  assert.equal(res.status, 400);
});

test("approval: a wrong secret fails, the right one gives a code, the code works one time", async () => {
  const q = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" };
  const page = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ ...q, response_type: "code" })}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<strong>Google<\/strong>/);
  assert.equal((await post("/oauth/authorize", form({ ...q, approval_secret: "wrong" }))).status, 401);
  const ok = await post("/oauth/authorize", form({ ...q, approval_secret: SECRET }));
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get("location"));
  assert.equal(back.searchParams.get("state"), "s1");
  const code = back.searchParams.get("code");
  const trade = () => post("/oauth/token", form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier }));
  const res = await trade();
  assert.equal(res.status, 200);
  tokens = await res.json();
  assert.equal(tokens.expires_in, 3600);
  assert.equal((await trade()).status, 400);
  assert.equal((await callMcp(tokens.access_token)).status, 200);
});

test("a reused refresh token revokes all tokens of the client", async () => {
  const refresh = (rt) => post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: rt, client_id: client.client_id, client_secret: client.client_secret }));
  const first = await refresh(tokens.refresh_token);
  assert.equal(first.status, 200);
  const next = await first.json();
  assert.equal((await callMcp(next.access_token)).status, 200);
  assert.equal((await refresh(tokens.refresh_token)).status, 400);
  assert.equal((await callMcp(next.access_token)).status, 401);
  assert.equal((await refresh(next.refresh_token)).status, 400);
});

test("the file holds no token that works, and a revoke from the command line reaches the running server", async () => {
  const q = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
  const code = new URL((await post("/oauth/authorize", form({ ...q, approval_secret: SECRET }))).headers.get("location")).searchParams.get("code");
  const t = await (await post("/oauth/token", form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier }))).json();
  assert.equal((await callMcp(t.access_token)).status, 200);
  const text = fs.readFileSync(FILE, "utf8");
  assert.ok(!text.includes(t.access_token) && !text.includes(t.refresh_token) && !text.includes(SECRET));
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  // A second object on the same file stands for the command `grok-x-mcp revoke`.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(make().revoke(client.client_id), true);
  assert.equal((await callMcp(t.access_token)).status, 401);
});

test("the log holds no token and no secret", () => {
  const all = logs.join("\n");
  for (const s of [SECRET, ADMIN, tokens.access_token, tokens.refresh_token, client.client_secret]) assert.ok(!all.includes(s));
});

test("audit: prototype names, bad Basic encoding, no redirect before approval, big bodies", async () => {
  for (const id of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    const res = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ client_id: id, redirect_uri: REDIRECT })}`);
    assert.equal(res.status, 400, id);
    const tok = await post("/oauth/token", form({ grant_type: "authorization_code", client_id: id, code: "x" }));
    assert.equal(tok.status, 401, id);
  }
  const basic = await fetch(`${origin}${ROUTE}/oauth/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from("%zz:%zz").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" });
  assert.equal(basic.status, 401);
  const reg = await (await post("/oauth/register", JSON.stringify({ redirect_uris: [REDIRECT] }), "application/json")).json();
  for (const q of [{ response_type: "token" }, { code_challenge_method: "plain", code_challenge: "x" }]) {
    const res = await fetch(`${origin}${ROUTE}/oauth/authorize?${form({ client_id: reg.client_id, redirect_uri: REDIRECT, ...q })}`, { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  }
  const big = await post("/oauth/register", "x".repeat(20 * 1024), "application/json");
  assert.equal(big.status, 413);
});

test("audit: strangers cannot fill the client table, and wrong tries never lock out the owner", async () => {
  for (let i = 0; i < 30; i++) {
    const r = await post("/oauth/register", JSON.stringify({ client_name: `spam${i}`, redirect_uris: [REDIRECT] }), "application/json");
    assert.equal(r.status, 201);
  }
  assert.ok(oauth.clients().filter((c) => !c.approved).length <= 10);
  const fresh = await (await post("/oauth/register", JSON.stringify({ client_name: "Owner", redirect_uris: [REDIRECT] }), "application/json")).json();
  const q = { client_id: fresh.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
  await Promise.all(Array.from({ length: 12 }, () => post("/oauth/authorize", form({ ...q, approval_secret: "wrong" }))));
  const ok = await post("/oauth/authorize", form({ ...q, approval_secret: SECRET }));
  assert.equal(ok.status, 302);
  assert.ok(new URL(ok.headers.get("location")).searchParams.get("code"));
});

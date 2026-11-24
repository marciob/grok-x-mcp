// Tests for the Grok Bot client, the x_search tool and the callback hook.
// A fake routine answers the webhook and POSTs the result to the callback,
// as the real routine does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toV2 } from "../src/grok.mjs";
import { createApp } from "../src/app.mjs";
import { serveHttp } from "../src/http.mjs";
import { setupPrompt } from "../src/setup.mjs";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const v2Result = (req_id, q) => ({
  type: "x_search_result", req_id, ok: true,
  results: [{ q, ok: true,
    data: [
      { id: "111", text: "hello  world", author_id: "u1", created_at: "2026-11-24T10:00:00Z", public_metrics: { like_count: 50, retweet_count: 2, reply_count: 1, impression_count: 900 } },
      { id: "222", text: "small", author_id: "u1", created_at: "2026-11-24T09:00:00Z", public_metrics: { like_count: 3 } },
    ],
    includes: { users: [{ id: "u1", username: "alice", name: "Alice" }] },
    meta: { result_count: 2, next_token: "NEXT" } }],
});

// A fake routine. `mode`: "ok", "silent" (no callback), "fail" (ok:false), or a status code.
function fakeRoutine(mode = "ok", hook) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), auth: init.headers.authorization, body });
    if (typeof mode === "number") return new Response("{}", { status: mode });
    if (mode !== "silent") {
      setTimeout(async () => {
        const u = new URL(body.callback_url);
        const result = mode === "fail" ? { type: "x_search_result", req_id: body.req_id, ok: false, error: "quota", detail: "daily limit" } : v2Result(body.req_id, body.queries[0].q);
        await hook({ url: u, body: JSON.stringify(result) });
      }, 5);
    }
    return new Response("{}", { status: 200 });
  };
  return { fetch, calls };
}

function setup(mode, extra = {}) {
  let app;
  const routine = fakeRoutine(mode, (x) => app.grok.callback(x));
  app = createApp({ config: { routineUrl: "https://routine.test/hook", routineKey: "secret-key", callbackUrl: "https://me.test/r/callback", maxPerHour: 5, ...extra }, fetch: routine.fetch, waitMs: 300 });
  const call = async (args) => (await app.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x_search", arguments: args } })).result;
  return { app, routine, call };
}

test("toV2 turns web operators into X API v2 operators and dates", () => {
  const r = toV2("from:alice -filter:replies filter:media min_faves:10 within_time:2d lang:pt", NOW);
  assert.equal(r.q, "from:alice -is:reply has:media lang:pt");
  assert.equal(r.minFaves, 10);
  assert.equal(r.start, "2026-11-22T12:00:00Z");
  assert.deepEqual(toV2("ai since:2026-11-01 until:2026-11-05").start, "2026-11-01T00:00:00Z");
  assert.throws(() => toV2("min_retweets:5 ai"), /min_retweets/);
  assert.throws(() => toV2("min_faves:5"), /no search words/);
});

test("x_search sends the request with the key, and gives posts with links and the next cursor", async () => {
  const { routine, call } = setup("ok");
  const r = await call({ query: "from:alice min_faves:10", feed: "top" });
  assert.equal(r.isError, false, r.content[0].text);
  const req = routine.calls[0];
  assert.equal(req.auth, "Bearer secret-key");
  assert.equal(req.body.type, "x_search");
  assert.deepEqual(req.body.queries[0], { q: "from:alice", max_results: 25, sort_order: "relevancy" });
  assert.match(req.body.callback_url, /^https:\/\/me\.test\/r\/callback\?req=gx-.+&token=.+/);
  assert.ok(Date.parse(req.body.expires_at) > Date.now());
  const t = r.content[0].text;
  assert.match(t, /^1 posts:/);
  assert.match(t, /@alice \(Alice\) .* 50 likes .* 900 views\n  hello world\n  https:\/\/x\.com\/alice\/status\/111/);
  assert.doesNotMatch(t, /small/);
  assert.match(t, /cursor "NEXT"/);
});

test("a cursor goes to the routine as next_token", async () => {
  const { routine, call } = setup("ok");
  await call({ query: "ai", cursor: "NEXT" });
  assert.equal(routine.calls[0].body.queries[0].next_token, "NEXT");
});

test("a slow search gives a req_id, and a second call with req_id gets the result", async () => {
  let app;
  const calls = [];
  const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response("{}"); };
  app = createApp({ config: { routineUrl: "https://routine.test/hook", routineKey: "k", callbackUrl: "https://me.test/r/callback", maxPerHour: 5 }, fetch, waitMs: 50 });
  const call = async (args) => (await app.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x_search", arguments: args } })).result;
  const first = await call({ query: "ai" });
  const id = /req_id "([^"]+)"/.exec(first.content[0].text)[1];
  const u = new URL(calls[0].callback_url);
  assert.equal((await app.grok.callback({ url: u, body: JSON.stringify(v2Result(id, "ai")) })).status, 200);
  const second = await call({ req_id: id });
  assert.match(second.content[0].text, /2 posts/);
  const unknown = await call({ req_id: "gx-nope" });
  assert.equal(unknown.isError, true);
});

test("the callback refuses a bad token, a wrong req_id and a body that is not JSON", async () => {
  const { app, routine } = setup("silent");
  const id = await app.grok.start({ query: "ai" });
  const good = new URL(routine.calls[0].body.callback_url);
  const bad = new URL(good);
  bad.searchParams.set("token", "wrong");
  assert.equal((await app.grok.callback({ url: bad, body: JSON.stringify(v2Result(id, "ai")) })).status, 403);
  assert.equal((await app.grok.callback({ url: good, body: "{" })).status, 400);
  assert.equal((await app.grok.callback({ url: good, body: JSON.stringify(v2Result("other", "ai")) })).status, 400);
  assert.equal((await app.grok.wait(id, 0)).status, "pending");
});

test("a failed search, a refused webhook and the hourly cap give clear errors", async () => {
  const failed = await setup("fail").call({ query: "ai" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /quota: daily limit/);

  const refused = await setup(401).call({ query: "ai" });
  assert.match(refused.content[0].text, /answered 401.*routine key/);

  const { call } = setup("silent", { maxPerHour: 1 });
  await call({ query: "ai" });
  const capped = await call({ query: "ai" });
  assert.match(capped.content[0].text, /limit \(MAX_SEARCHES_PER_HOUR\)/);
});

test("the HTTP server takes the callback with no bearer token, and still guards the MCP route", async () => {
  const { app, routine } = setup("silent");
  const running = await serveHttp({ server: app.server, adminToken: "a".repeat(40), route: "/r", hooks: { "/r/callback": app.grok.callback } });
  try {
    const id = await app.grok.start({ query: "ai" });
    const cb = new URL(routine.calls[0].body.callback_url);
    const ok = await fetch(`http://127.0.0.1:${running.port}/r/callback${cb.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v2Result(id, "ai")) });
    assert.equal(ok.status, 200);
    assert.equal((await app.grok.wait(id, 0)).status, "done");
    const mcp = await fetch(`http://127.0.0.1:${running.port}/r`, { method: "POST", body: "{}" });
    assert.equal(mcp.status, 401);
  } finally {
    await running.close();
  }
});

test("the setup prompt names the exact callback prefix and asks to keep the key out of the chat", () => {
  const p = setupPrompt("https://me.test/r/callback");
  assert.match(p, /start with exactly "https:\/\/me\.test\/r\/callback\?"/);
  assert.match(p, /searchPostsAll/);
  assert.match(p, /Do not show them in this chat/);
});

test("the tool schema stays plain, for clients such as Gemini", async () => {
  const { app } = setup("ok");
  const r = await app.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const s = JSON.stringify(r.result.tools[0].inputSchema);
  for (const bad of ["anyOf", "$ref", "additionalProperties", "oneOf"]) assert.ok(!s.includes(bad), bad);
});

test("the configuration refuses a PUBLIC_URL on a port other than 443", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  const env = { PUBLIC_URL: "https://host.example:10000/r", GROK_ROUTINE_URL: "https://routine.test/h", GROK_ROUTINE_KEY: "k", APPROVAL_SECRET: "s".repeat(20) };
  assert.throws(() => loadConfig(env), /port 10000.*443/);
  assert.equal(loadConfig({ ...env, PUBLIC_URL: "https://host.example/r" }).callbackUrl, "https://host.example/r/callback");
});

// X search through a Grok Bot routine.
//
// Grok Bot has no API for its X connector: only the model of the Bot can call
// it. A routine with a webhook trigger is the way in:
//
//   1. search() keeps a pending request with a one-time token, then POSTs the
//      request to the webhook of the routine (Authorization: Bearer <key>).
//   2. The routine runs the x_search skill of the Bot, which calls the X
//      connector, and POSTs the result to callback_url.
//   3. callback() checks the token and stores the result. search() waits for
//      it, or gives a req_id that the client asks for again.
//
// The pending requests live in memory. A restart of the server loses the
// searches that run at that moment, and nothing else.
//
// Sources:
// - https://docs.x.ai/grok-bot/skills-routines-and-automations
// - https://docs.x.com/x-api/posts/search/introduction (the v2 query operators)
import crypto from "node:crypto";

const KEEP_MS = 15 * 60_000;
const EXPIRES_MS = 5 * 60_000;
const MAX_PENDING = 50;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// The operators of the X web search become the operators of the X API v2.
// v2 has no likes filter: min_faves goes out of the query and is applied to
// the result here.
export function toV2(query, now = Date.now()) {
  const map = {
    "filter:replies": "is:reply", "-filter:replies": "-is:reply",
    "filter:retweets": "is:retweet", "-filter:retweets": "-is:retweet",
    "filter:nativeretweets": "is:retweet", "-filter:nativeretweets": "-is:retweet",
    "filter:media": "has:media", "-filter:media": "-has:media",
    "filter:images": "has:images", "filter:videos": "has:videos", "filter:links": "has:links",
    "filter:quote": "is:quote", "-filter:quote": "-is:quote",
  };
  let minFaves = 0;
  let start;
  let end;
  const out = [];
  for (const tok of String(query).split(/\s+/).filter(Boolean)) {
    if (map[tok]) out.push(map[tok]);
    else if (/^min_faves:\d+$/.test(tok)) minFaves = Number(tok.slice(10));
    else if (/^since_time:\d+$/.test(tok)) start = isoSeconds(Number(tok.slice(11)) * 1000);
    else if (/^until_time:\d+$/.test(tok)) end = isoSeconds(Number(tok.slice(11)) * 1000);
    else if (/^since:\d{4}-\d{2}-\d{2}$/.test(tok)) start = `${tok.slice(6)}T00:00:00Z`;
    else if (/^until:\d{4}-\d{2}-\d{2}$/.test(tok)) end = `${tok.slice(6)}T00:00:00Z`;
    else if (/^within_time:\d+[dhm]$/.test(tok)) {
      const n = parseInt(tok.slice(12), 10);
      const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[tok.slice(-1)];
      start = isoSeconds(now - n * unit);
    } else if (/^min_(retweets|replies):/.test(tok)) throw new Error(`${tok} does not work in this search. Use min_faves, or filter the result yourself.`);
    else out.push(tok);
  }
  if (!out.length) throw new Error("The query has no search words or operators left. Add a word, from:user, or another operator.");
  return { q: out.join(" "), minFaves, start, end };
}

// One X API v2 post, with its author from includes.users, as a flat object.
export function flatPost(p, users) {
  const u = users.find((x) => x.id === p.author_id) ?? {};
  const m = p.public_metrics ?? {};
  return {
    id: p.id,
    url: `https://x.com/${u.username ?? "i"}/status/${p.id}`,
    author: u.username,
    name: u.name,
    date: p.created_at,
    text: p.text,
    likes: m.like_count,
    reposts: m.retweet_count,
    replies: m.reply_count,
    quotes: m.quote_count,
    views: m.impression_count,
    lang: p.lang,
  };
}

// `routineUrl`, `routineKey`: the webhook of the routine. `callbackUrl`: the
// public URL of the callback hook. `maxPerHour`: a cap on webhook calls, under
// the routine limit of Grok Bot (200 runs an hour for one routine).
export function createGrok({ routineUrl, routineKey, callbackUrl, maxPerHour = 60, fetch = globalThis.fetch, now = () => Date.now() }) {
  const pending = new Map();
  const sent = [];

  function sweep() {
    const t = now();
    for (const [id, r] of pending) if (t - r.at > KEEP_MS) pending.delete(id);
    while (sent.length && t - sent[0] > 3_600_000) sent.shift();
  }

  // Starts one search. Returns its req_id.
  async function start({ query, feed = "latest", limit = 20, cursor }) {
    sweep();
    if (sent.length >= maxPerHour) throw new Error(`This server sent ${maxPerHour} searches in the last hour, its limit (MAX_SEARCHES_PER_HOUR). Try again later.`);
    if ([...pending.values()].filter((r) => r.status === "pending").length >= MAX_PENDING) throw new Error("Too many searches are running. Try again in a minute.");
    const v2 = toV2(query, now());
    const reqId = `gx-${now()}-${crypto.randomBytes(4).toString("hex")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const q = {
      q: v2.q,
      max_results: Math.max(10, Math.min(25, v2.minFaves ? 25 : limit)),
      sort_order: feed === "top" ? "relevancy" : "recency",
      ...(v2.start && { start_time: v2.start }),
      ...(v2.end && { end_time: v2.end }),
      ...(cursor && { next_token: cursor }),
    };
    const body = {
      type: "x_search",
      req_id: reqId,
      expires_at: isoSeconds(now() + EXPIRES_MS),
      queries: [q],
      callback_url: `${callbackUrl}?req=${encodeURIComponent(reqId)}&token=${token}`,
    };
    const entry = { at: now(), tokenHash: sha(token), query, minFaves: v2.minFaves, status: "pending", result: null, error: null, waiters: [] };
    pending.set(reqId, entry);
    let r;
    try {
      r = await fetch(routineUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${routineKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      pending.delete(reqId);
      throw new Error(`The Grok Bot webhook did not answer: ${e.message}`);
    }
    if (!r.ok) {
      pending.delete(reqId);
      const hint = r.status === 401 || r.status === 403 ? " The routine key is wrong or was replaced. Copy it again from the routine in the Grok Bot app." : r.status === 429 ? " The routine run limit of Grok Bot is reached. Try again later." : " Check that the routine is not paused.";
      throw new Error(`The Grok Bot webhook answered ${r.status}.${hint}`);
    }
    sent.push(now());
    return reqId;
  }

  // Waits up to `ms` for a result. Returns { status: "done", posts, cursor },
  // { status: "pending" }, { status: "error", error } or { status: "unknown" }.
  async function wait(reqId, ms) {
    const r = pending.get(reqId);
    if (!r) return { status: "unknown" };
    if (r.status === "pending" && ms > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        r.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return view(r);
  }

  function view(r) {
    if (r.status === "pending") return { status: "pending" };
    if (r.status === "error") return { status: "error", error: r.error };
    const res = r.result?.results?.[0];
    if (!r.result?.ok || !res?.ok) return { status: "error", error: [res?.error ?? r.result?.error ?? "unknown error", res?.detail ?? r.result?.detail].filter(Boolean).join(": ") };
    const users = res.includes?.users ?? [];
    const posts = (Array.isArray(res.data) ? res.data : []).map((p) => flatPost(p, users)).filter((p) => (p.likes ?? 0) >= r.minFaves);
    return { status: "done", posts, cursor: res.meta?.next_token ?? null };
  }

  // The hook for the routine: POST <callbackUrl>?req=…&token=… with the result.
  async function callback({ url, body }) {
    const reqId = url.searchParams.get("req") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const r = pending.get(reqId);
    if (!r || !crypto.timingSafeEqual(sha(token), r.tokenHash)) return { status: 403, body: { ok: false, error: "unknown request or bad token" } };
    let result;
    try {
      result = JSON.parse(body);
    } catch {
      return { status: 400, body: { ok: false, error: "the body is not JSON" } };
    }
    if (!result || result.req_id !== reqId) return { status: 400, body: { ok: false, error: "req_id does not match" } };
    if (r.status === "pending") {
      r.status = "done";
      r.result = result;
      for (const w of r.waiters.splice(0)) w();
    }
    return { status: 200, body: { ok: true } };
  }

  return { start, wait, callback, pending };
}

// Tests for the optional x_video tool: off by default, the request it sends,
// the result it shows, and the setup text with the x_video skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postId } from "../src/grok.mjs";
import { createApp } from "../src/app.mjs";
import { setupPrompt } from "../src/setup.mjs";
import { loadConfig } from "../src/config.mjs";

const videoResult = (req_id, extra = {}) => ({
  type: "x_video_result", req_id, ok: true,
  post: { id: "2125641758432284978", url: "https://x.com/NASA/status/2125641758432284978", author: "NASA", text: "Medicine or engineering?" },
  video: { duration_ms: 17664, url: "https://video.twimg.com/v.mp4" },
  visual: "00:00 Eight astronauts in blue flight suits. 00:10 NASA logo.",
  on_screen_text: "none",
  transcript: "00:00 NASA needs people from a wide variety of backgrounds.",
  audio: "Instrumental music.",
  ...extra,
});

// `mode`: "ok", "silent" (no callback) or "fail" (ok:false, no_video).
function setup(mode, extra = {}) {
  let app;
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (mode !== "silent") {
      const result = mode === "fail" ? { type: "x_video_result", req_id: body.req_id, ok: false, error: "no_video" } : videoResult(body.req_id, body.question ? { answer: "The logo is blue." } : {});
      setTimeout(() => app.grok.callback({ url: new URL(body.callback_url), body: JSON.stringify(result) }), 5);
    }
    return new Response("{}");
  };
  app = createApp({ config: { routineUrl: "https://routine.test/hook", routineKey: "k", callbackUrl: "https://me.test/r/callback", maxPerHour: 5, enableVideo: true, ...extra }, fetch, waitMs: 300 });
  const call = async (args) => (await app.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x_video", arguments: args } })).result;
  const list = async () => (await app.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  return { app, calls, call, list };
}

test("postId takes an id or an x.com / twitter.com status URL, and nothing else", () => {
  assert.equal(postId("2125641758432284978"), "2125641758432284978");
  assert.equal(postId("https://x.com/NASA/status/2125641758432284978?s=20"), "2125641758432284978");
  assert.equal(postId("https://twitter.com/NASA/status/2125641758432284978/video/1"), "2125641758432284978");
  assert.throws(() => postId("https://evil.test/NASA/status/123456"), /post id/);
  assert.throws(() => postId("abc"), /post id/);
});

test("x_video is off by default: no tool, and the setup text has no x_video skill", async () => {
  const off = setup("ok", { enableVideo: false });
  assert.deepEqual(await off.list(), ["x_search"]);
  assert.doesNotMatch(setupPrompt("https://me.test/r/callback"), /x_video/);
  const env = { PUBLIC_URL: "https://host.example/r", GROK_ROUTINE_URL: "https://routine.test/h", GROK_ROUTINE_KEY: "k", APPROVAL_SECRET: "s".repeat(20) };
  assert.equal(loadConfig(env).enableVideo, false);
  assert.equal(loadConfig({ ...env, ENABLE_X_VIDEO: "1" }).enableVideo, true);
});

test("x_video sends the post id and the question, and shows the reading", async () => {
  const { calls, call, list } = setup("ok");
  assert.deepEqual(await list(), ["x_search", "x_video"]);
  const r = await call({ post: "https://x.com/NASA/status/2125641758432284978", question: "  what  color is the logo " });
  assert.equal(r.isError, false, r.content[0].text);
  assert.equal(calls[0].type, "x_video");
  assert.equal(calls[0].post_id, "2125641758432284978");
  assert.equal(calls[0].question, "what color is the logo");
  assert.ok(Date.parse(calls[0].expires_at) - Date.now() > 9 * 60_000);
  const t = r.content[0].text;
  assert.match(t, /^Video of @NASA · 18 s · https:\/\/x\.com\/NASA\/status\/2125641758432284978/);
  assert.match(t, /Answer to the question:\nThe logo is blue\./);
  assert.match(t, /Speech \(transcript\):\n00:00 NASA needs people/);
  assert.match(t, /watchVideo subagent of Grok Bot/);
});

test("x_video gives a req_id when slow, and clear errors", async () => {
  const slow = setup("silent", { maxPerHour: 1 });
  const first = await slow.call({ post: "2125641758432284978" });
  const id = /req_id "([^"]+)"/.exec(first.content[0].text)[1];
  await slow.app.grok.callback({ url: new URL(slow.calls[0].callback_url), body: JSON.stringify(videoResult(id)) });
  assert.match((await slow.call({ req_id: id })).content[0].text, /Video of @NASA/);
  assert.match((await slow.call({ post: "2125641758432284978" })).content[0].text, /MAX_SEARCHES_PER_HOUR/);

  const failed = await setup("fail").call({ post: "2125641758432284978" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /failed: no_video/);
  assert.match((await setup("ok").call({ post: "not a post" })).content[0].text, /post id/);
});

test("the setup text with video makes the x_video skill and lets the routine take both types", () => {
  const p = setupPrompt("https://me.test/r/callback", { video: true });
  assert.match(p, /name: x_video/);
  assert.match(p, /watchVideo/);
  assert.match(p, /"type" is not "x_search" or "x_video"/);
  assert.match(p, /Run the skill with the same name as "type"/);
  assert.match(p, /start with exactly "https:\/\/me\.test\/r\/callback\?"/);
  assert.match(p, /3\. A routine named "x_search webhook"/);
});

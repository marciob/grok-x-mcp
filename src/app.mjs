// Puts the parts together: the Grok Bot client, the x_search tool, the optional
// x_video tool (ENABLE_X_VIDEO=1), the MCP server.
import fs from "node:fs";
import { createServer, ToolError } from "./rpc.mjs";
import { createGrok } from "./grok.mjs";
import { mediaLines, fetchImages, IMAGE_LIMITS } from "./media.mjs";

export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0";
  }
}

// A web client stops a tool call after about 60 seconds, and the server stops
// a tool at 50. A search that is not back in this time gives a req_id.
export const WAIT_MS = 40_000;

const INSTRUCTIONS =
  "This server searches X (Twitter) posts through the Grok Bot of its owner. " +
  "Posts change all the time: always call x_search, and never answer from memory. " +
  "One search takes 20 to 40 seconds. If x_search says that the search still runs, call it again with only req_id. " +
  "Quote posts exactly and give their links. Never invent a post, a number or a link. Say plainly when nothing was found.";

const num = (n) => (n === undefined || n === null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function formatPost(p, attached) {
  const counts = [`${num(p.likes)} likes`, `${num(p.reposts)} reposts`, `${num(p.replies)} replies`, ...(p.views !== undefined && p.views !== null ? [`${num(p.views)} views`] : [])].join(" · ");
  return [`@${p.author ?? "?"}${p.name ? ` (${p.name})` : ""} · ${p.date ?? "?"} · ${counts}`, `  ${String(p.text ?? "").replace(/\s+/g, " ").trim()}`, ...mediaLines(p.media, attached), `  ${p.url}`].join("\n");
}

// Text first, then the images. An image that fails becomes a note, and the text stays.
async function format(r, query, images, fetchImpl) {
  if (!r.posts.length) return `No posts found${query ? ` for "${query}"` : ""}.`;
  let att = { images: [], attached: new Map(), notes: [] };
  if (images && r.posts.some((p) => p.media?.length)) att = await fetchImages(r.posts, { maxImages: IMAGE_LIMITS.maxImages }, fetchImpl);
  const next = r.cursor ? `Next page: call x_search with the same query and cursor "${r.cursor}".` : "";
  const body = [`${r.posts.length} posts:`, ...r.posts.map((p) => formatPost(p, att.attached)), ...att.notes, next].filter(Boolean).join("\n");
  return { content: [{ type: "text", text: body }, ...att.images], isError: false };
}

const VIDEO_INSTRUCTIONS =
  " x_video reads the video of one post (what it shows, the text on screen, the speech) through the watchVideo subagent of Grok Bot. " +
  "It takes about 1 to 3 minutes: when it says that the reading still runs, call it again with only req_id. Report only what it returned.";

export function formatVideo(v) {
  const dur = v.durationMs ? ` · ${Math.round(v.durationMs / 1000)} s` : "";
  return [
    `Video of @${v.author || "?"}${dur} · ${v.url}`,
    v.text && `Post text: ${v.text.replace(/\s+/g, " ").trim()}`,
    v.answer && `Answer to the question:\n${v.answer}`,
    v.visual && `What the video shows:\n${v.visual}`,
    v.onScreenText && `Text on screen:\n${v.onScreenText}`,
    `Speech (transcript):\n${v.transcript || "(no speech)"}`,
    v.audio && `Other sound:\n${v.audio}`,
    "Source: the watchVideo subagent of Grok Bot. It can make mistakes: quote it as its reading, not as fact.",
  ].filter(Boolean).join("\n\n");
}

export function createApp({ config, fetch = globalThis.fetch, waitMs = WAIT_MS }) {
  const grok = createGrok({
    routineUrl: config.routineUrl,
    routineKey: config.routineKey,
    callbackUrl: config.callbackUrl,
    maxPerHour: config.maxPerHour,
    fetch,
  });

  const xSearch = {
    name: "x_search",
    title: "Search X",
    description:
      "Searches X (Twitter) posts with X search operators: from:user, to:user, @user, \"exact phrase\", OR, -word, lang:pt, " +
      "filter:replies, -filter:replies, filter:media, min_faves:N, within_time:2d, since:YYYY-MM-DD, until:YYYY-MM-DD. " +
      "Each post line has the author, date, likes, reposts, replies, views, text, media (type, size, direct URL, alt text) and link. images: true also attaches up to 4 photos as images. One search takes 20 to 40 seconds. " +
      "If the result says that the search still runs, call again with only req_id. Posts change all the time: always call this tool, and never answer from memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The X search query, with operators. Required unless req_id is given." },
        feed: { type: "string", enum: ["latest", "top"], description: 'Default "latest" (newest first). "top": most relevant.' },
        limit: { type: "integer", description: "Posts on one page, 10 to 25. Default 20." },
        cursor: { type: "string", description: "The cursor of an earlier result, for the next page. Use it with the same query." },
        req_id: { type: "string", description: "The req_id of a search that still runs. Give only this to get its result." },
        images: { type: "boolean", description: "true: also attach up to 4 photos (or video posters) as images. Default false. The media URLs are always in the text." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const images = args.images === true || args.images === "true";
      const reqId = typeof args.req_id === "string" && args.req_id ? args.req_id : null;
      if (reqId) {
        const r = await grok.wait(reqId, waitMs);
        if (r.status === "unknown") throw new ToolError(`No search has req_id ${reqId}. Start a new search with query.`);
        if (r.status === "pending") return `The search ${reqId} still runs. Call x_search again with req_id "${reqId}" in about 20 seconds. Do not answer from memory meanwhile.`;
        if (r.status === "error") throw new ToolError(`The search ${reqId} failed: ${r.error}`);
        return format(r, undefined, images, fetch);
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new ToolError('Give "query", or "req_id" of a search that still runs.');
      if (query.length > 512) throw new ToolError('"query" is longer than 512 characters');
      const feed = args.feed === undefined ? "latest" : String(args.feed).toLowerCase();
      if (!["latest", "top"].includes(feed)) throw new ToolError('"feed" is "latest" or "top"');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolError('"limit" is a whole number from 10 to 25');
      const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
      let id;
      try {
        id = await grok.start({ query, feed, limit, cursor });
      } catch (e) {
        throw new ToolError(e.message);
      }
      const r = await grok.wait(id, waitMs);
      if (r.status === "pending") return `The search still runs (req_id ${id}). Call x_search again with req_id "${id}" in about 20 seconds. Do not answer from memory meanwhile.`;
      if (r.status === "error") throw new ToolError(`The search failed: ${r.error}`);
      return format(r, query, images, fetch);
    },
  };

  const xVideo = {
    name: "x_video",
    title: "Read an X video",
    description:
      "Reads the video of one X post through Grok Bot: what it shows (scene by scene, with times), the text on screen, the speech as a transcript, and other sound. " +
      "Give the post as an id or an x.com status URL. question (optional) asks for one thing in the video. It takes about 1 to 3 minutes. " +
      "If the result says that the reading still runs, call again with only req_id. Use x_search first to find the post when you have no link.",
    inputSchema: {
      type: "object",
      properties: {
        post: { type: "string", description: "The post id, or its x.com status URL. Required unless req_id is given." },
        question: { type: "string", description: "Optional. One thing to look for in the video, such as \"what does the chart at the end show\". At most 500 characters." },
        req_id: { type: "string", description: "The req_id of a reading that still runs. Give only this to get its result." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const reqId = typeof args.req_id === "string" && args.req_id ? args.req_id : null;
      const show = (r, id) => {
        if (r.status === "unknown") throw new ToolError(`No reading has req_id ${id}. Start a new one with post.`);
        if (r.status === "pending") return `The video reading still runs (req_id ${id}). Call x_video again with req_id "${id}" in about 30 seconds. Do not answer from memory meanwhile.`;
        if (r.status === "error") throw new ToolError(`The video reading failed: ${r.error}`);
        return formatVideo(r.video);
      };
      if (reqId) return show(await grok.wait(reqId, waitMs), reqId);
      if (typeof args.post !== "string" || !args.post.trim()) throw new ToolError('Give "post" (a post id or x.com URL), or "req_id" of a reading that still runs.');
      if (args.question !== undefined && typeof args.question !== "string") throw new ToolError('"question" is text');
      let id;
      try {
        id = await grok.startVideo({ post: args.post, question: args.question });
      } catch (e) {
        throw new ToolError(e.message);
      }
      return show(await grok.wait(id, waitMs), id);
    },
  };

  const tools = config.enableVideo ? [xSearch, xVideo] : [xSearch];
  const server = createServer({ tools, instructions: INSTRUCTIONS + (config.enableVideo ? VIDEO_INSTRUCTIONS : ""), serverInfo: { name: "grok-x-mcp", version: packageVersion() } });
  return { server, grok, tools };
}

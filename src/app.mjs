// Puts the parts together: the Grok Bot client, the x_search tool, the MCP server.
import fs from "node:fs";
import { createServer, ToolError } from "./rpc.mjs";
import { createGrok } from "./grok.mjs";

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

export function formatPost(p) {
  const counts = [`${num(p.likes)} likes`, `${num(p.reposts)} reposts`, `${num(p.replies)} replies`, ...(p.views !== undefined && p.views !== null ? [`${num(p.views)} views`] : [])].join(" · ");
  return `@${p.author ?? "?"}${p.name ? ` (${p.name})` : ""} · ${p.date ?? "?"} · ${counts}\n  ${String(p.text ?? "").replace(/\s+/g, " ").trim()}\n  ${p.url}`;
}

function format(r, query) {
  if (!r.posts.length) return `No posts found${query ? ` for "${query}"` : ""}.`;
  const next = r.cursor ? `\nNext page: call x_search with the same query and cursor "${r.cursor}".` : "";
  return `${r.posts.length} posts:\n${r.posts.map(formatPost).join("\n")}${next}`;
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
      "Each post line has the author, date, likes, reposts, replies, views, text and link. One search takes 20 to 40 seconds. " +
      "If the result says that the search still runs, call again with only req_id. Posts change all the time: always call this tool, and never answer from memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The X search query, with operators. Required unless req_id is given." },
        feed: { type: "string", enum: ["latest", "top"], description: 'Default "latest" (newest first). "top": most relevant.' },
        limit: { type: "integer", description: "Posts on one page, 10 to 25. Default 20." },
        cursor: { type: "string", description: "The cursor of an earlier result, for the next page. Use it with the same query." },
        req_id: { type: "string", description: "The req_id of a search that still runs. Give only this to get its result." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args) {
      const reqId = typeof args.req_id === "string" && args.req_id ? args.req_id : null;
      if (reqId) {
        const r = await grok.wait(reqId, waitMs);
        if (r.status === "unknown") throw new ToolError(`No search has req_id ${reqId}. Start a new search with query.`);
        if (r.status === "pending") return `The search ${reqId} still runs. Call x_search again with req_id "${reqId}" in about 20 seconds. Do not answer from memory meanwhile.`;
        if (r.status === "error") throw new ToolError(`The search ${reqId} failed: ${r.error}`);
        return format(r);
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
      return format(r, query);
    },
  };

  const server = createServer({ tools: [xSearch], instructions: INSTRUCTIONS, serverInfo: { name: "grok-x-mcp", version: packageVersion() } });
  return { server, grok, tools: [xSearch] };
}

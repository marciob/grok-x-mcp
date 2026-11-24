// The MCP protocol layer: one JSON-RPC message in, one answer out. It knows
// nothing about X or Grok. The tools come from the caller.
//
// The server speaks two forms of the protocol. A client of 2025-11-25 or
// before starts with `initialize`. A client of 2026-07-28 sends no handshake,
// and each request carries the version in `_meta`.
//
// Sources:
// - https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// - https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
// - https://modelcontextprotocol.io/specification/2026-07-28/server/tools
export const MODERN = "2026-07-28";
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_KEY = "io.modelcontextprotocol/serverInfo";

// A web client stops a tool call after about 60 seconds. A tool that takes
// longer gets an error result before that, so the model can try again.
export const TOOL_TIMEOUT_MS = 50_000;

export const text = (value, isError = false) => ({ content: [{ type: "text", text: String(value) }], isError });

// A model sometimes tells the user that an action worked when the tool
// failed. Each error result says plainly that the call failed.
const failed = (message, reason) => ({
  ...text(`ERROR: the call failed. Tell the user that it failed, and why. ${message}`, true),
  _reason: reason,
});

// An error that a tool returns to the model as text, not as a crash.
export class ToolError extends Error {}

// `tools` is a list of { name, title, description, inputSchema, annotations, run(args, ctx) }.
// `run` returns a string or a result object.
export function createServer({ tools, instructions, serverInfo, timeoutMs = TOOL_TIMEOUT_MS }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

  async function call(tool, args) {
    let timer;
    const controller = new AbortController();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolError(`The call took more than ${Math.round(timeoutMs / 1000)} seconds and stopped. Call again.`));
      }, timeoutMs);
    });
    try {
      const out = await Promise.race([tool.run(args, { signal: controller.signal }), timeout]);
      return typeof out === "string" ? text(out) : out;
    } catch (e) {
      if (e instanceof ToolError) return failed(e.message, e.message.slice(0, 120));
      return failed(`The tool failed: ${e?.message ?? e}`, "crash");
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(message) {
    const id = message?.id;
    const answers = id !== undefined && id !== null;
    const fail = (code, msg, data) => (answers ? { jsonrpc: "2.0", id, error: { code, message: msg, ...(data ? { data } : {}) } } : null);
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    // A notification (no id) gets no answer.
    if (!answers) return null;

    const method = message.method;
    const params = message.params ?? {};
    const asked = params._meta?.[VERSION_KEY];
    const modern = asked !== undefined || method === "server/discover";
    if (asked !== undefined && asked !== MODERN) {
      return fail(-32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: asked });
    }
    const done = (result, extra = {}) => ({
      jsonrpc: "2.0",
      id,
      result: modern ? { resultType: "complete", ...result, ...extra, _meta: { [SERVER_KEY]: serverInfo } } : result,
    });

    if (method === "initialize") {
      const wanted = params.protocolVersion;
      return done({
        protocolVersion: LEGACY.includes(wanted) ? wanted : LEGACY[0],
        capabilities: { tools: {} },
        serverInfo,
        instructions,
      });
    }
    if (method === "ping") return done({});
    if (method === "server/discover") {
      return done({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: {} }, instructions }, { ttlMs: 3_600_000, cacheScope: "private" });
    }
    if (method === "tools/list") return done({ tools: listed }, { ttlMs: 300_000, cacheScope: "private" });
    if (method === "tools/call") {
      const tool = typeof params.name === "string" ? byName.get(params.name) : undefined;
      if (!tool) return fail(-32602, `Unknown tool: ${String(params.name).slice(0, 80)}`);
      const args = params.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return fail(-32602, "The arguments of a tool are an object");
      const result = await call(tool, args);
      const reason = result._reason;
      delete result._reason;
      const answer = done(result);
      // The reason goes to the log line, not to the client.
      if (reason) Object.defineProperty(answer, "reason", { value: reason, enumerable: false });
      return answer;
    }
    return fail(-32601, `Method not found: ${method.slice(0, 80)}`);
  }

  return { handle, tools: listed };
}

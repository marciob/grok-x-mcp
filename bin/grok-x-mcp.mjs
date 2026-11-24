#!/usr/bin/env node
// The command line: start the server, print the Grok Bot setup text, test the
// routine, manage OAuth clients.
import crypto from "node:crypto";
import { loadConfig } from "../src/config.mjs";
import { createApp, packageVersion } from "../src/app.mjs";
import { createOAuth } from "../src/oauth.mjs";
import { serveHttp } from "../src/http.mjs";
import { setupPrompt } from "../src/setup.mjs";

const HELP = `grok-x-mcp ${packageVersion()}

Usage:
  grok-x-mcp setup-prompt     Print the text to paste into your Grok Bot (makes the skill and the routine)
  grok-x-mcp serve            Start the MCP server over HTTP
  grok-x-mcp test "<query>"   Start the server for one search through your routine, then stop
  grok-x-mcp clients          List the OAuth clients (such as ChatGPT or Claude)
  grok-x-mcp revoke <id>      Remove one OAuth client and its tokens ("all" for every client)
  grok-x-mcp random           Print a random value, for a route or a secret

Configuration: environment variables. See README.md.`;

const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

function oauthOf(config) {
  return createOAuth({ approvalSecret: config.approvalSecret, publicUrl: config.publicUrl, route: config.route, file: config.oauthFile, redirectHosts: config.redirectHosts, log });
}

async function start(config) {
  const app = createApp({ config });
  const running = await serveHttp({
    server: app.server,
    adminToken: config.adminToken,
    oauth: oauthOf(config),
    route: config.route,
    hooks: { [config.callbackRoute]: app.grok.callback },
    host: config.host,
    port: config.port,
    log,
  });
  return { app, running };
}

async function main([cmd, ...rest]) {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "random") return console.log(crypto.randomBytes(16).toString("hex"));

  if (cmd === "setup-prompt") {
    const config = loadConfig(process.env, { needRoutine: false });
    return console.log(setupPrompt(config.callbackUrl));
  }

  const config = loadConfig(process.env, { needRoutine: ["serve", "test"].includes(cmd) });

  if (cmd === "serve") {
    const { running } = await start(config);
    log(`grok-x-mcp ${packageVersion()} listens on http://${config.host}:${running.port}${config.route} for ${config.publicUrl}`);
    log(`routine callback: ${config.callbackUrl}. At most ${config.maxPerHour} searches an hour.`);
    if (config.approvalSecretFile) log(`approval secret: in ${config.approvalSecretFile}`);
    const stop = () => running.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }

  if (cmd === "test") {
    const query = rest.join(" ").trim() || "from:xai";
    const { app, running } = await start(config);
    log(`searching "${query}" through the routine. The callback must reach ${config.callbackUrl}, so the tunnel must run.`);
    const began = Date.now();
    const id = await app.grok.start({ query, feed: "latest", limit: 10 });
    const r = await app.grok.wait(id, 120_000);
    await running.close();
    if (r.status !== "done") throw new Error(r.status === "pending" ? "no result in 120 seconds. Check the routine runs in the Grok Bot app, and that the tunnel sends the callback path to this server." : `the search failed: ${r.error}`);
    console.log(`OK: ${r.posts.length} posts in ${Math.round((Date.now() - began) / 1000)} s.`);
    for (const p of r.posts.slice(0, 3)) console.log(`- @${p.author}: ${String(p.text).replace(/\s+/g, " ").slice(0, 100)}  ${p.url}`);
    return;
  }

  if (cmd === "clients") {
    const rows = oauthOf(config).clients();
    if (rows.length === 0) return console.log("No OAuth client.");
    for (const c of rows) console.log(`${c.id}  ${c.approved ? "approved" : "not approved"}  ${c.at.slice(0, 16)}  ${c.name}  ${c.redirectHosts.join(" ")}`);
    return;
  }

  if (cmd === "revoke") {
    const id = rest[0];
    if (!id) throw new Error("give a client id from: grok-x-mcp clients (or all)");
    if (!oauthOf(config).revoke(id)) throw new Error(`no client ${id}`);
    return console.log(id === "all" ? "Removed all clients and tokens." : `Removed ${id} and its tokens.`);
  }

  throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`grok-x-mcp: ${e.message}\n`);
  process.exit(1);
});

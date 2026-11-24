// The configuration, from environment variables. Each secret can come from
// the variable itself or from a file (the variable with _FILE after it). A
// file is better, because a variable can show in a process list or a log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_REDIRECT_HOSTS } from "./oauth.mjs";

const csv = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function secret(env, name) {
  if (env[`${name}_FILE`]) {
    const file = env[`${name}_FILE`].replace(/^~(?=\/)/, os.homedir());
    const mode = fs.statSync(file).mode & 0o077;
    if (mode !== 0) throw new Error(`${file} can be read by other users. Run: chmod 600 ${file}`);
    return fs.readFileSync(file, "utf8").trim();
  }
  return env[name]?.trim() || null;
}

// `needRoutine`: false for the commands that work before the routine exists,
// such as setup-prompt.
export function loadConfig(env = process.env, { needRoutine = true } = {}) {
  const dataDir = (env.DATA_DIR || path.join(os.homedir(), ".grok-x-mcp")).replace(/^~(?=\/)/, os.homedir());

  if (!env.PUBLIC_URL) throw new Error("set PUBLIC_URL: the https address of the MCP endpoint, such as https://host.example/7f3a9c...");
  let publicUrl = env.PUBLIC_URL.replace(/\/+$/, "");
  const u = new URL(publicUrl);
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("PUBLIC_URL must start with https://");
  // Grok Bot runs reach only port 443: a callback on another port fails with
  // a TLS error on their side, and the search result never arrives.
  if (u.port && !local) throw new Error(`PUBLIC_URL uses port ${u.port}. Use the default https port (443): a Grok Bot routine cannot reach another port.`);
  let route = u.pathname.replace(/\/+$/, "");
  if (!route) {
    route = "/mcp";
    publicUrl += route;
  }

  const routineUrl = env.GROK_ROUTINE_URL?.trim() || null;
  const routineKey = secret(env, "GROK_ROUTINE_KEY");
  if (needRoutine && (!routineUrl || !routineKey)) {
    throw new Error("set GROK_ROUTINE_URL and GROK_ROUTINE_KEY_FILE (or GROK_ROUTINE_KEY): the webhook of your Grok Bot routine. Run `grok-x-mcp setup-prompt` first.");
  }
  if (routineUrl && new URL(routineUrl).protocol !== "https:") throw new Error("GROK_ROUTINE_URL must start with https://");

  // The approval secret: from the configuration, or made once and kept in
  // the data directory.
  let approvalSecret = secret(env, "APPROVAL_SECRET");
  let approvalSecretFile = null;
  if (!approvalSecret) {
    approvalSecretFile = path.join(dataDir, "approval.secret");
    try {
      approvalSecret = fs.readFileSync(approvalSecretFile, "utf8").trim();
    } catch {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      approvalSecret = crypto.randomBytes(24).toString("base64url");
      fs.writeFileSync(approvalSecretFile, approvalSecret + "\n", { mode: 0o600 });
    }
  }

  const adminToken = secret(env, "ADMIN_TOKEN");
  if (adminToken && adminToken === approvalSecret) throw new Error("ADMIN_TOKEN and APPROVAL_SECRET must differ");

  const port = Number(env.PORT || 7815);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT is a number from 0 to 65535");
  const maxPerHour = Number(env.MAX_SEARCHES_PER_HOUR || 60);
  if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 200) throw new Error("MAX_SEARCHES_PER_HOUR is a number from 1 to 200 (Grok Bot runs one routine at most 200 times an hour)");

  return {
    publicUrl,
    route,
    callbackRoute: `${route}/callback`,
    callbackUrl: `${publicUrl}/callback`,
    routineUrl,
    routineKey,
    maxPerHour,
    approvalSecret,
    approvalSecretFile,
    adminToken,
    host: env.HOST || "127.0.0.1",
    port,
    dataDir,
    oauthFile: path.join(dataDir, "oauth.json"),
    redirectHosts: env.ALLOWED_REDIRECT_HOSTS ? csv(env.ALLOWED_REDIRECT_HOSTS) : DEFAULT_REDIRECT_HOSTS,
  };
}

# grok-x-mcp

Search X (Twitter) from ChatGPT, Claude or Gemini through your own Grok Bot.

You already pay for Grok Bot. Its X connector can search X. This small server lets your chat apps use that search, with no X API account and no extra cost beyond your Grok Bot plan.

- It is an MCP server that you run on your own machine or VPS.
- It has one tool: `x_search`.
- It has no npm dependencies. It uses only Node.js 22.
- It has its own OAuth server, so ChatGPT, Claude and Gemini can connect with no client ID.

## How it works

Grok Bot has no API for its X search. Only the model of the Bot can call it. A Grok Bot routine with a webhook trigger is the way in:

1. Your chat app calls `x_search` on this server.
2. The server POSTs the search to the webhook of your routine.
3. The routine runs the `x_search` skill of your Bot. The skill calls the X connector of the Bot.
4. The routine POSTs the posts back to this server, at `<PUBLIC_URL>/callback`, with a one-time token.
5. The server gives the posts to your chat app.

One search takes 20 to 40 seconds. If it takes longer, the tool gives a `req_id`, and the chat app asks again.

Each post comes with its media: type, size, direct URL and the author's alt text ("none" when there is none). With `images: true`, the tool also attaches up to 4 photos (or video posters) as images, at most 1 MB each and 3 MB in total. A photo that fails to download becomes a note, and the text stays.

## What you need

| Item | Why |
|---|---|
| Grok Bot, with its X connector | It does the search. Grok Bot comes with X Premium, Super and Ultra. |
| A machine that stays on, with Node.js 22 or later | It runs the server. A small VPS is the easy choice. Your own computer also works while it is on. |
| A public https address on port 443 for that machine | Your chat app and the routine must reach the server. A Grok Bot routine reaches only port 443, so do not use another port. Tailscale Funnel and cloudflared are free, and need no domain. |
| A chat app that takes a custom MCP connector | ChatGPT, Claude or Gemini. Check that your plan allows custom connectors. |

You do not need a database, an X API key, or a GitHub or Google app.

## Set up

### 1. Get the code and choose the address

```sh
git clone https://github.com/marciob/grok-x-mcp.git
cd grok-x-mcp
export PUBLIC_URL="https://your-host.example/$(node bin/grok-x-mcp.mjs random)"
```

The path of `PUBLIC_URL` is random. It is the MCP endpoint. Keep it.

### 2. Make the skill and the routine in Grok Bot

```sh
node bin/grok-x-mcp.mjs setup-prompt
```

1. Copy the text that it prints.
2. Paste it into a normal chat with your Grok Bot, in the app. The Bot makes the skill `x_search` and the routine `x_search webhook`. Do not send it through a routine or an automation: a routine run cannot make another routine.
3. Open the routine in the Grok Bot desktop app. In the **Webhook** section, copy the **POST to** URL and the **key**.

The routine accepts only a callback that starts with your `PUBLIC_URL`. If you change `PUBLIC_URL`, run `setup-prompt` again and give the new text to the Bot.

### 3. Store the webhook

```sh
mkdir -p ~/.grok-x-mcp && chmod 700 ~/.grok-x-mcp
pbpaste > ~/.grok-x-mcp/routine.key   # or paste the key with an editor
chmod 600 ~/.grok-x-mcp/routine.key
export GROK_ROUTINE_URL="https://…"   # the POST to URL
export GROK_ROUTINE_KEY_FILE=~/.grok-x-mcp/routine.key
```

### 4. Put the server online

The server listens on `127.0.0.1:7815`. Put an https proxy or a tunnel in front of it. The proxy must send these paths to the server:

- the route (the path of `PUBLIC_URL`), and all paths under it, which includes `/callback` and `/oauth/`
- `/.well-known/oauth-protected-resource<route>`
- `/.well-known/oauth-authorization-server<route>`
- `/.well-known/openid-configuration<route>`

Use port 443. A Grok Bot routine cannot reach another port (such as 8443 or 10000): its POST fails with a TLS error, and no result arrives.

With Tailscale Funnel, for each path above:

```sh
tailscale funnel --bg --set-path /<route> http://127.0.0.1:7815/<route>
```

With cloudflared or Caddy, send the whole host to `http://127.0.0.1:7815`.

### 5. Test, then run

```sh
node bin/grok-x-mcp.mjs test "from:xai"   # one real search through your routine
node bin/grok-x-mcp.mjs serve
```

`test` prints the first posts and the time. If it fails, it says why.

### 6. Add the connector

1. In ChatGPT, Claude or Gemini, add a custom connector with the URL `PUBLIC_URL`.
2. The app opens the approval page of the server. Enter the approval secret:

   ```sh
   cat ~/.grok-x-mcp/approval.secret
   ```

3. Ask, for example: "Search X for the latest posts from @xai about Grok Bot."

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_URL` | yes | | Public https address of the MCP endpoint, with a random path. |
| `GROK_ROUTINE_URL` | yes | | The webhook URL of your routine. |
| `GROK_ROUTINE_KEY_FILE` | yes, or `GROK_ROUTINE_KEY` | | File with the webhook key, mode 600. |
| `MAX_SEARCHES_PER_HOUR` | no | `60` | A cap on searches, 1 to 200. |
| `APPROVAL_SECRET_FILE` | no | made in `DATA_DIR/approval.secret` | The secret that the approval page asks for. |
| `ADMIN_TOKEN_FILE` | no | none | A fixed bearer token, for curl. 32 characters or more. |
| `ALLOWED_REDIRECT_HOSTS` | no | Gemini, claude.ai, chatgpt.com, localhost | OAuth redirect hosts. |
| `HOST` | no | `127.0.0.1` | Listen address. |
| `PORT` | no | `7815` | Listen port. |
| `DATA_DIR` | no | `~/.grok-x-mcp` | OAuth clients and tokens. |

## Search operators

`from:user`, `to:user`, `@user`, `"exact phrase"`, `OR`, `-word`, `lang:pt`, `filter:replies`, `-filter:replies`, `filter:media`, `filter:images`, `filter:videos`, `filter:links`, `min_faves:N`, `within_time:2d`, `since:YYYY-MM-DD`, `until:YYYY-MM-DD`, `since_time:UNIX`, `until_time:UNIX`.

The server changes them to the operators of the X API v2. `min_faves` is applied to the result, because the v2 search has no likes filter. `min_retweets` and `min_replies` do not work.

## Limits and cost

- **Cost.** Each search is one routine run, and each run spends usage of your Grok Bot plan. There is no other cost.
- **Grok Bot routines.** A routine runs at most 200 times an hour, and all your routines together at most 300 times an hour ([docs](https://docs.x.ai/grok-bot/skills-routines-and-automations)). `MAX_SEARCHES_PER_HOUR` keeps the server under that.
- **The X connector.** The instructions of the connector give 30 calls a minute, 1,000 a day (reset at 00:00 UTC), and at most 25 posts a call. These numbers come from the Bot, not from a public page, and can change.
- **Speed.** 20 to 40 seconds a search.

## Use it fairly

This server is for your own searches with your own Grok Bot. Read the [xAI Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy). It forbids, among other things, "Scraping, harvesting or reselling any Input or Output" and "circumventing any rate limits". Do not share your server with other people, do not resell results, and do not use it for bulk collection. Your Grok account is the one at risk.

## Security model

1. **The routine checks the callback.** It sends results only to an address that starts with your `PUBLIC_URL`.
2. **One-time tokens.** Each search has its own random token in the callback URL. The server keeps only its SHA-256 digest, and forgets it after 15 minutes.
3. **Old requests do nothing.** Each request has `expires_at`, 5 minutes after it is sent. The routine drops a request after that time.
4. **OAuth approval.** A chat app must pass the approval page, which asks for the approval secret. Access tokens last 1 hour.
5. **Post text is data.** The routine and the skill treat the webhook body and the posts as data, not as instructions.
6. **The log has one line for each request,** with no content, tokens or secrets.

## Commands

```sh
grok-x-mcp setup-prompt     # text for your Grok Bot
grok-x-mcp test "<query>"   # one real search
grok-x-mcp serve            # start the server
grok-x-mcp clients          # list the OAuth clients
grok-x-mcp revoke <id>      # remove one client and its tokens ("all" for every client)
grok-x-mcp random           # a random value for a route or a secret
```

## Tests

```sh
npm test
```

The tests need no Grok Bot and no network. They use a fake routine.

## License

MIT

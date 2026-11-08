# Chat requests from Slack and Discord

Someone types `/ravelon <request>` in Slack or Discord. The request reaches the
Ravelon desktop of an account that allowed that workspace, channel and person,
and waits there as a draft. **Nothing runs on this server or on its own**: the
person at that computer chooses a project, an agent and its access, and starts
it. A reply goes back only when they send one, as text.

## Setting up the chat apps

Each platform is offered only when both of its values are set. They stay on the
server: no route returns them and no log line names them.

| Variable | Where it comes from |
| --- | --- |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`), scope `chat:write`, `commands` |
| `DISCORD_PUBLIC_KEY` | Discord application → General Information → Public Key (64 hex characters) |
| `DISCORD_BOT_TOKEN` | Discord application → Bot → Token, with Send Messages in the channels it answers in |

**Slack**: create a slash command `/ravelon` with the request URL
`<PUBLIC_URL>/v1/chat/slack/commands`, and invite the app to the channels it
should answer in.

**Discord**: set the Interactions Endpoint URL to
`<PUBLIC_URL>/v1/chat/discord/interactions` and register the command once:

```sh
curl -X POST "https://discord.com/api/v10/applications/<application id>/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"ravelon","description":"Send a request to Ravelon","options":[
        {"type":1,"name":"ask","description":"A request for an agent","options":[{"type":3,"name":"text","description":"The request","required":true}]},
        {"type":1,"name":"link","description":"Link your Discord account","options":[{"type":3,"name":"code","description":"The code from Ravelon","required":true}]}]}'
```

## Linking and allowing

1. In Ravelon, the person asks for a code (`POST /v1/chat/link-codes`, valid ten
   minutes, once).
2. They type `/ravelon link <code>` (Slack) or `/ravelon link code:<code>`
   (Discord). The chat identity is now linked to their account; one chat
   identity belongs to one account.
3. The channel of that command and the person become the first allowed ones.
   More channels and people are allowed by id from the desktop.

A request is delivered to every account whose link is in that workspace and
that allowed both the channel and the person. Anything else is answered with
"Ravelon is not set up for this channel or for you", which says nothing about
which accounts exist.

## HTTP contract

| Route | Purpose |
| --- | --- |
| `GET /v1/chat` | `{ platforms: { slack, discord }, links: [{ id, platform, workspaceId, workspaceLabel, memberId, memberLabel, allowed: [{ id, kind, value, label }] }] }` |
| `POST /v1/chat/link-codes` | `{ platform }` → `201 { code, expiresAt }`; `404 chat_unavailable` without that chat app |
| `DELETE /v1/chat/links/:id` | Unlinks; the allowed channels and people go with it |
| `POST /v1/chat/links/:id/allowed` | `{ kind: "channel" \| "member", value, label? }` → `201 { id, kind, value, label }`; at most 100 per link |
| `DELETE /v1/chat/allowed/:id` | Removes one |
| `POST /v1/chat/requests/take` | `{ requests: [{ id, platform, workspaceLabel, channelId, channelLabel, memberLabel, text, createdAt, expiresAt }] }`: the waiting requests, each handed out once |
| `POST /v1/chat/requests/:id/reply` | `{ text }` (at most 3000 characters) → `{ posted: true }`; three replies per request; `502 chat_reply_failed` when the chat app does not take it |
| `POST /v1/chat/slack/commands` | Slack slash command (form body, HMAC-SHA256 signature, five-minute window) |
| `POST /v1/chat/discord/interactions` | Discord interactions (JSON body, Ed25519 signature, five-minute window); answers Discord's ping |

Answers to a command are shown only to the person who typed it. Replies are
posted in the request's channel, addressed to its sender; no other mention
notifies anyone (Slack text is escaped, Discord allows no other mention).

## Limits and storage

Migration `005_chat_requests` adds `chat_link_codes` (digests only),
`chat_links`, `chat_allowed` and `chat_requests`. Request text is stored as it
arrived, for at most seven days, and handed to the desktop once; the daily
cleanup deletes expired codes and requests. An account keeps at most 50
waiting requests (the oldest make room), a workspace may send 60 requests a
minute, and the chat app routes take 120 requests per IP and minute before
their signature is checked. Deleting an account deletes its links and requests.

# Agent relay v1

The agent relay connects two authenticated sessions of the same account to a
running desktop host. It is independent of encrypted vault record sync and its
`vaultChanged` hints. The server forwards opaque JSON bodies without decrypting,
persisting, replaying or logging them. A controller still needs the desktop's
explicit end-to-end grant; account membership grants no execution rights.

## HTTP contract

Every request uses `Authorization: Bearer <access token>`, with a live device
session. Tokens in query parameters are refused by the strict relay query schema.
A device ID identifies an account login session, not a physical computer.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/agents/capabilities` | Authenticated account | `{protocol:1,enabled:true,canConnect,hostLimit}` |
| `POST /v1/agents/hosts` | `{clientId,label}`; relay entitlement | `{id,label,online:false}` (200) |
| `GET /v1/agents/hosts` | Authenticated account | `{hosts:[{id,label,online}]}` |
| `DELETE /v1/agents/hosts/:id` | Registered owner session | Empty 204 |

Client and server routing IDs are canonical lowercase UUIDs. Labels are trimmed,
nonempty and at most 120 characters. The client supplies its persistent clientId;
the server creates the host routing ID. A live host cannot be claimed or removed
by another login session, even within the same account. Registration serializes
per-account quota checks. It first removes that account's registrations whose
owner has no live refresh session, closes their connections and creates a new
routing ID when the client registers again. Old grants require fresh pairing.
Owners may list or delete registrations after their entitlement ends.

## WebSocket contract

`/v1/agents/relay?hostId=<uuid>&role=host|controller` accepts the bearer header.
The host role requires the registered owner session; the controller role requires
the same account and current relay entitlement. An offline host closes controller
connections with 1008 `host_offline`. Host replacement, removal or revocation closes
all attached controllers. Messages sent during connection setup are refused.

| Sender | JSON message | Receiver |
| --- | --- | --- |
| Server | `{type:"connected",routeId,deviceId}` | New controller |
| Server | `{type:"controllerJoined",routeId,deviceId}` | Host |
| Server | `{type:"controllerLeft",routeId}` | Host |
| Controller | `{type:"frame",body}` | Host receives `{type:"frame",routeId,deviceId,body}` |
| Host | `{type:"frame",routeId,body}` | Only that controller receives `{type:"frame",body}` |

The body must be a JSON object. Sender/device IDs are never accepted from clients.
Unknown fields, invalid roles/IDs, binary and malformed frames close the connection.
The service does not inspect the encrypted packet or the initial grant join body.
Hosts cannot address controllers of another host.
Replies to controller routes that have already closed are discarded without
disconnecting the host or its other controllers.

Both endpoints' account, token, device, host and relay permissions are checked
before every forwarded frame and every 25 seconds while idle. Database errors
fail closed; authorization has a five-second deadline. Protocol ping/pong frames
keep idle connections alive; a missing pong closes the routes. Send buffers and
pending authorization buffers are each capped at 2 MiB. There is no offline queue.
Shutdown clears the routing maps and closes connections.

Limits are 1 MiB UTF-8 for the final encoded JSON frame, 30 application frames and
8 MiB per one-second window per connection, and eight controllers per host.
Added routing metadata counts toward the encoded frame cap. Compression is disabled.
The shared WebSocket transport accepts at most 1 MiB. The only preexisting WS route,
`/v1/sync/events`, separately retains its previous incoming byte cap before any
parsing; its three-field outgoing hint format is unchanged.

Native clients send no Origin. Browser handshakes allow only the configured public
web origin, configured CORS origins, `tauri://localhost` and
`http://tauri.localhost`. Credentials remain in the Authorization header.

Routing is process-local. Run one relay API process, or ensure both endpoints of a
host reach the same process. A multi-instance service needs coordinated live
routing before removing this constraint; database host rows alone are insufficient.
No command persistence is an acceptable substitute for live routing.

## Disposable client integration fixture

```sh
node --import tsx server/test/fixtures/agent-relay-server.ts
# http://127.0.0.1:4311
```

The fixture binds only to literal loopback, uses an in-memory database, prints its
disposable account credentials and erases data on exit. Sign in from isolated
native clients; no real account or provider credentials are needed. `PORT` overrides
the default. Keep loopback HTTP restricted to local test clients; remote deployments
use HTTPS/WSS. The fixture must not be deployed.

Focused tests cover real two-client socket routing, owner and account boundaries,
replaced/revoked hosts, malformed/oversized/spoofed frames and old sync limits.
Hub boundary tests cover rate/backpressure, idle revocation/database failure,
heartbeat, pending authorization, final encoded sizes and shutdown. No UI changed.

## Capability and storage

Self-hosted relay is free and requires no licence. Email-verification policy still
applies. `AGENT_RELAY_HOST_LIMIT` defaults to 3 and accepts 1 to 100 (values are
clamped). Migration `003_agent_relay_hosts` stores only owner/account IDs, client
and routing IDs, label and creation time. Foreign keys delete registrations with
the account or device. Online state is live memory, never a database flag.

# Agent relay v1

## Closed-app iOS alerts

With the explicitly configured HTTPS push relay, capabilities add optional
`attention:1`; otherwise it is absent and `POST /v1/push/devices` stores no
token and answers `{registered:false}`. Registration validates the iOS token,
environment and `app.ravelon.ios` topic, and optional boolean `agentAlerts`
defaults false. A live session owns its registration. Token rotation and
`DELETE /v1/push/devices` remove that session's old opaque relay subscription;
deletion answers 204. Failed remote removals stay in a durable outbox and
retry on later requests and once per minute. Expired/revoked/disabled sessions
are excluded immediately; maintenance queues their remote removal. Account
deletion removes local registrations. Remote subscriptions also expire at
the session deadline, at most sixty days after registration.

The owning live session may post `{v:1,event,ref,excludedDeviceIds?}` to
`/v1/agents/hosts/:id/attention`. Events are exactly `approval`, `input`,
`planReady`, `failed`, `completed`. The host UUID and optional excluded device
UUIDs are canonical lowercase; up to 100 unique exclusions temporarily filter
this account's devices and are never stored or forwarded. `ref` is canonical
base64url with 40 through 512 ASCII characters and at least 28 sealed bytes. Extra fields, titles,
paths and plaintext thread IDs are refused. This free self-hosted path has no
Cloud licence or payment check.

Selection requires an enabled account, opted-in iOS registration, matching
device ownership and a live unrevoked/unexpired refresh session. Registration
revalidates after remote HTTP, so sign-out or a newer registration in flight
cannot enable a stale device. Its random `rps_` ID changes on registration,
and cleanup never deletes a newer account's registration. The configured
relay receives only selected opaque IDs and
`{type:agentAttention,v:1,hostId,event,ref}`. Existing sync mutations forward
`{type:vaultChanged,cursor}` to live vault-member devices independently of the
agent-alert preference.

The database enforces one event per host per ten seconds, sixty per sliding
hour, across replicas. Rate timestamps expire after an hour of inactivity.
A 429 has bounded `Retry-After` (1 through 3600 seconds); relay failures return
503 and retry guidance, without including upstream bodies or credentials.
202 `{accepted:number}` means accepted for processing, not displayed.

`server/test/agent-attention.test.ts` exercises actual Fastify routes and an
injected relay HTTP transport. The joint Cloud HTTP/2 capture exercises the
APNs payload; neither proves Apple delivery. Final closed-app acceptance
requires the signed iPhone build and real APNs service.

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

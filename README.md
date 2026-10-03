# abot-sms

Internal Cloudflare Worker that sends SMS by calling the **existing live air-broker worker**. It does not change that worker, and it does not add routes to it. Callers use MCP. abot.run sits in front and prefixes these tools as `sms_<tool>`.

## Caller API

`GET /health` (and `GET /`) returns `{ "ok": true, "service": "abot-sms" }`.

`POST /mcp` speaks MCP JSON-RPC 2.0. It handles `initialize`, `ping`, `tools/list`, and `tools/call`. A notification such as `notifications/initialized` gets HTTP 202 and an empty body. Responses are JSON, not a server-sent event stream.

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_devices` | none | `{ "devices": [ ... ] }` |
| `list_contacts` | `deviceId` | `{ "contacts": [ ... ] }` |
| `send_sms` | `deviceId`, `to`, `content` | `{ "ok", "req_id", "receipt" }` |

Tool names are unprefixed. A gateway that mounts this worker advertises `sms_list_devices`, `sms_list_contacts`, and `sms_send_sms`, and forwards `tools/call` with the original name and the same arguments. Each `inputSchema` is an object schema with those argument names, so the prefix does not have to rewrite the schema.

`tools/call` returns the payload as text content and as `structuredContent`. A bad argument is a JSON-RPC error `-32602`. An air-broker failure is a tool result with `isError: true`. A receipt whose `status` is `fail` (including the live worker's device or number rate limit) is a successful tool result with `{ "ok": false, "req_id", "receipt" }`. The message was published; the live worker or the device rejected it.

`GET /devices`, `GET /contacts`, and `POST /sms` are not routes on this worker.

## What it calls

`AIR_BROKER_URL` is the origin of the live worker (for example `https://<air-broker-host>`). Every call uses only APIs that worker already implements.

| MCP tool | Live air-broker |
| --- | --- |
| `list_devices` | `POST /auth` with `{ "code" }`, then `GET /devices` with the `SESSION` cookie |
| `list_contacts` | Same session, then `GET /contacts/:device`. If that response is not successful, `GET /contacts?device=` |
| `send_sms` | WebSocket upgrade to `/ws`. Subscribe to `air780e/response/<deviceId>`, then publish `{ "action": "publish", "topic": "air780e/command/<deviceId>", "payload": { "command": "send_sms", "to", "content", "req_id" } }` and wait for the matching receipt |

The live worker has no SMS HTTP route. The send uses the WebSocket publish the browser console already uses.

There is no new air-broker authentication. Listing devices and contacts uses the browser access-code session, because those `GET`s reject anything else. The WebSocket uses that same session cookie, unless device-token credentials are configured, in which case the socket is `GET /ws?device=<id>&dtoken=<token>`.

The live session is bound to the caller IP for 10 minutes. This client logs in on the same invocation as the request that uses the cookie, and retries that login once after a `401`. It does not cache the cookie and it does not ask the live worker to change that check.

## Environment variables

Set these with `wrangler secret put` or a local `.dev.vars` file. Do not commit values.

| Name | Required | Purpose |
| --- | --- | --- |
| `AIR_BROKER_URL` | yes | HTTPS origin of the live air-broker worker. `http` is accepted only for `localhost` / `127.0.0.1`. |
| `AIR_BROKER_ACCESS_CODE` | yes | One access code the live worker already accepts at `POST /auth` (`VALID_CODES` on that worker). |
| `AIR_BROKER_DEVICE_ID` | no | Device id for the existing `/ws?device=&dtoken=` flow. Ignored unless the token is set too. |
| `AIR_BROKER_DEVICE_TOKEN` | no | Device token paired with `AIR_BROKER_DEVICE_ID`. When both are set, SMS uses that WebSocket instead of the session cookie. Listing still uses the access code. |

`AIR_BROKER_URL` and `AIR_BROKER_ACCESS_CODE` are declared in `secrets.required`. The device pair is optional and is not required at deploy time.

## Local checks

```bash
npm install
npm test
npm run typecheck
```

`npm run dev` and `npm run deploy` talk to Cloudflare and, once secrets are set, to the live air-broker worker. They do not deploy or edit that worker.

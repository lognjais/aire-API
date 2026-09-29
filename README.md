# aire-api

Realtime polling API on **Cloudflare Workers** + **Durable Objects** + **D1**.

- One Durable Object per poll (WebSocket Hibernation API — sleeps idle, wakes instantly).
- D1 for poll metadata and vote dedupe (`UNIQUE(poll_id, voter_id)`).
- Per-poll tally cached in DO storage; updated atomically per vote and broadcast over all open sockets.
- No cold starts. Free tier covers ~3M req/month.

**Live:** https://aire-api.altrusian.workers.dev
**Frontend:** https://github.com/lognjais/aire

## API

| Method | Path | Body / params | Response |
|---|---|---|---|
| `GET`  | `/`                       | —                                        | `{ ok, service, version }`               |
| `POST` | `/polls`                  | `{ title?, questions: string[] }`        | `{ id, title, questions }`               |
| `GET`  | `/polls/:id`              | —                                        | `{ id, title, questions, createdAt }`    |
| `GET`  | `/polls/:id/results`      | —                                        | `{ counts, total }`                      |
| `WS`   | `/polls/:id/ws`           | upgrade                                  | streams `init`, `tally`, `voted`, `error`|

### WebSocket protocol

Client → Server:
```json
{ "type": "vote", "voterId": "<uuid>", "answers": { "0": "yes", "1": "no" } }
{ "type": "ping" }
```

Server → Client:
```json
{ "type": "init",  "questions": [...], "tally": { "counts": {...}, "total": 0 } }
{ "type": "tally", "tally": { "counts": {...}, "total": 12 } }
{ "type": "voted" }
{ "type": "error", "message": "already voted" }
{ "type": "pong" }
```

Vote dedupe: each client generates a stable `voterId` (UUID, in `localStorage`) and the server
enforces uniqueness via `UNIQUE(poll_id, voter_id)` in D1.

## Run locally

```bash
npm install
npm run db:migrate:local   # apply schema to local D1
npm run dev                # http://127.0.0.1:8787
```

## Deploy

```bash
npm run deploy             # wrangler deploy
npm run db:migrate         # apply schema to remote D1 (idempotent)
npm run tail               # live logs
```

The first time you set this up on a new account:

```bash
wrangler login
wrangler d1 create aire    # paste the database_id into wrangler.toml
npm run db:migrate
npm run deploy
```

## File layout

```
src/
├── index.ts       # Worker entry: routes HTTP, upgrades WebSockets
└── poll.ts        # PollRoom Durable Object (Hibernation API)
schema.sql         # D1 schema
wrangler.toml      # bindings (D1 + Durable Object)
```

## Free tier limits (as of 2025-2026)

- Workers: 100k requests/day
- Durable Objects: 1M requests/month + 13k GB-seconds duration
- D1: 5M reads/day, 100k writes/day, 5 GB storage
- WebSockets via DO hibernation: only billed when a socket is actively delivering a message

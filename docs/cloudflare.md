# Cloudflare preview setup

The Worker serves the Vite build, HTTP API, WebSocket signaling, optional server AI route, TURN credential route, and the `RoomObject` SQLite Durable Object.

The production `AI` binding in `wrangler.jsonc` enables five allow-listed Cloudflare Workers AI profiles. It does not require an application-managed provider token.

## Local

```bash
pnpm install
pnpm dev
```

The Vite server at `http://localhost:5173` proxies `/api` and WebSockets to Wrangler at `http://localhost:8787`.

To exercise deployment-owned MiniMax locally without copying its token, run the Worker with the ignored production staging file:

```bash
pnpm --filter @drawguessai/worker dev:prod-ai
```

Authenticated Cloudflare Workers AI testing uses the production environment and incurs normal Workers AI usage:

```bash
pnpm --filter @drawguessai/worker dev:cloudflare-ai
```

## Optional TURN

Store the Cloudflare Realtime TURN key ID and API token as secrets:

```bash
pnpm --filter @drawguessai/worker exec wrangler secret put TURN_KEY_ID --env production
pnpm --filter @drawguessai/worker exec wrangler secret put TURN_KEY_API_TOKEN --env production
```

Without those secrets the room uses Cloudflare’s public STUN address and transparently falls back to WebSocket previews. With them, authenticated room members receive short-lived ICE server credentials and the relay-only room option becomes effective.

The production Worker also declares separate rate-limit bindings for room creation, room joins, server AI calls, and TURN credential issuance. The Durable Object additionally bounds WebSocket message/signaling rates and per-turn reactions. Rate-limit namespace IDs in `wrangler.jsonc` must remain unique within the deployment account.

`APP_ORIGIN` may remain empty on the first same-origin `workers.dev` deployment, in which case invite URLs use the request origin. Set it to an exact HTTPS origin, without a path or trailing slash, before placing the Worker behind another public hostname.

## Deployment

`pnpm build` performs a Wrangler dry run only. The project preview is available at `https://drawguessai-preview.wujingit.workers.dev`. A fork should change the production Worker name in `wrangler.jsonc` before deploying to its own Cloudflare account.

Deployment-owned MiniMax secrets can be uploaded from the ignored staging file. Review the target account and Worker name first; never commit or copy the file into a release artifact:

```bash
cd apps/worker
pnpm exec wrangler secret bulk .prod.vars --env production
```

Deploy the already-audited build with:

```bash
pnpm --filter @drawguessai/web build
pnpm --filter @drawguessai/worker exec wrangler deploy --env production
```

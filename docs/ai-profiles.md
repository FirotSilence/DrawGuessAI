# AI profiles

## Browser-owned profiles

Open Model settings from the first screen and choose either:

- `openai-compatible`: `POST {baseUrl}/v1/chat/completions`
- `anthropic-compatible`: `POST {baseUrl}/v1/messages`

The client uses `fetch`, not a provider SDK. Configure model name, vision support, structured-output mode, zero to two checkpoint observations, and drawing planning mode. `Fast` plans privately and draws in one request; `Detailed` makes a separate structured-plan request first. A non-vision profile may draw once from text, but it cannot guess a drawing or inspect a checkpoint. The lobby validates every assigned seat before starting.

The endpoint must allow the application origin through CORS. DrawGuessAI deliberately has no arbitrary cloud proxy for browser-owned URLs. For a local compatibility gateway, allow the Vite origin during development:

```text
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Headers: authorization, content-type, x-api-key, anthropic-version
Access-Control-Allow-Methods: POST, OPTIONS
```

### CCSwitch development preset

In Vite development mode, the built-in profile is always named `CCSwitch`. It sends Anthropic Messages requests through the fixed same-origin path `/ccswitch`, which proxies to `http://127.0.0.1:5000`. No model is shown because the active provider and model are selected entirely inside CCSwitch; the request's internal placeholder model is rewritten by CCSwitch. No API key is required by the local gateway.

Only the active provider's capabilities must be declared in `apps/web/.env.local`, so the lobby can prevent incompatible seat assignments:

```dotenv
VITE_CCSWITCH_VISION=false
VITE_CCSWITCH_MAX_OBSERVATION_PASSES=0
VITE_CCSWITCH_REASONING_MODE=disabled
```

Restart Vite after switching to a provider with different capabilities. Official DeepSeek V4 supports text input, not image input, so a CCSwitch route to DeepSeek must set vision to `false`; it can draw from a phrase and generate prompts/reviews, but it cannot guess a canvas or visually inspect a checkpoint. `reasoningMode=disabled` sends the compatible `thinking: { type: "disabled" }` request field, preventing DeepSeek from spending the complete compact prompt/review output budget on private reasoning before it emits JSON. Switching CCSwitch to a genuinely vision-capable provider requires setting vision to `true` and observation passes to the desired value from zero to two.

The preset is compiled only by Vite's development server, `/ccswitch` exists only in Vite's local proxy, and the dev server binds to `127.0.0.1`. A deployed DrawGuessAI instance does not publish this preset or a route to the host's CCSwitch. Entering `127.0.0.1:5000` in an online browser would address that online user's own computer, not the deployment host.

### Direct DeepSeek development preset

Local development can also call DeepSeek's official Anthropic-compatible endpoint directly, without CCSwitch. Set `DEEPSEEK_API_KEY` as a user or process environment variable and restart Vite:

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "your-token", "User")
```

Optional non-secret overrides are supported in the ignored `apps/web/.env.local` file:

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=DeepSeek-V4-Flash
```

The development-only profile is named `DeepSeek · Direct (text only)`. Vite injects the token only while serving the local development bundle, which is why the server is loopback-only. Production builds receive `null`, do not contain this token, and do not expose this profile. The token is never sent to the DrawGuessAI Worker, room WebSocket, DataChannel, logs, or replay, but it is necessarily visible to the owner in local browser developer tools and in the browser's direct request to DeepSeek.

Direct browser access depends on the provider's current CORS policy. An official URL plus token works only when that endpoint permits the deployed DrawGuessAI origin, request method, and authorization headers; otherwise the browser blocks it and the user needs a provider-supported local gateway. DrawGuessAI intentionally does not provide an arbitrary cloud forwarding proxy.

DeepSeek's official V4 API cannot supply the requested image understanding. Use a genuinely multimodal profile for guess seats and checkpoint inspection, such as the deployment-owned Cloudflare Gemma 4, Llama 4 Scout, Kimi K2.6, or Moondream profile, or MiniMax-M3. DeepSeek Direct remains useful on prompt, drawing, and review seats.

## Deployment-owned profiles

Server profiles are optional. The public `/api/config` response exposes only ID, label, execution mode, and capabilities. Keys and model request bodies are never included.

### MiniMax-M3

Set the following Worker secrets to enable the built-in `MiniMax · MiniMax-M3` server profile. It is declared as vision-capable and can guess images or inspect up to two drawing checkpoints.

```dotenv
MINIMAX_API_KEY=replace-me
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
MINIMAX_MODEL=MiniMax-M3[1M]
MINIMAX_MAX_OBSERVATION_PASSES=2
```

The local production staging file is `apps/worker/.prod.vars`. It is ignored by Git. When present, the default `pnpm dev` command loads it into the local Worker so the same MiniMax server profile can be tested without duplicating credentials. A deployer may upload it with `wrangler secret bulk .prod.vars --env production` after verifying the target account and Worker name. An open-source checkout without this file still starts normally and simply omits deployment-owned server profiles.

`MINIMAX_MAX_OBSERVATION_PASSES` declares the deployment-owned model ceiling from zero to two. It does not override the room request: an AI drawing uses the lower of the room value and this ceiling. Zero advertises the profile as one-shot. The CCSwitch `ANTHROPIC_AUTH_TOKEN` is sent to MiniMax as `Authorization: Bearer ...`; the token never enters the public profile response, room event stream, replay, or browser bundle.

Game turns use MiniMax's direct response mode rather than the Anthropic `thinking` field because extended thinking can consume the compact turn budget before emitting the required JSON. Draw and guess prompts still request a brief private plan, use a lower `0.45` sampling temperature, and expose only public execution stages such as requesting, inspecting, and refining. Provider thinking blocks are discarded if an endpoint returns them; they never enter the UI, room stream, logs, or replay.

MiniMax error `2056` is classified separately as `token-plan-window-exhausted`. It means the current rolling Token Plan resource window is unavailable, which is distinct from an exhausted account balance or weekly allowance. The adapter does not repeatedly call the provider for this non-transient-in-turn condition, and the game UI explains the distinction instead of reporting a generic account quota failure.

### Cloudflare Workers AI

The production `AI` binding supplies five allow-listed choices without provider API keys:

| Profile                    | Model                                     | Allowed turns                               |
| -------------------------- | ----------------------------------------- | ------------------------------------------- |
| Cloudflare · Gemma 4 26B   | `@cf/google/gemma-4-26b-a4b-it`           | prompt, draw, guess, review, one checkpoint |
| Cloudflare · Llama 4 Scout | `@cf/meta/llama-4-scout-17b-16e-instruct` | prompt, draw, guess, review, one checkpoint |
| Cloudflare · Kimi K2.6     | `@cf/moonshotai/kimi-k2.6`                | prompt, draw, guess, review, one checkpoint |
| Cloudflare · Moondream 3.1 | `@cf/moondream/moondream3.1-9B-A2B`       | guess only                                  |
| Cloudflare · GLM-4.7 Flash | `@cf/zai-org/glm-4.7-flash`               | prompt, review, and one-shot draw only      |

Gemma, Kimi, and GLM use the native chat-completions response schema. Llama uses guided JSON, and Moondream uses its image-query task. Every result still passes the shared Zod contract, one repair attempt, and the non-blocking fallback path because provider-side JSON constraints are not treated as sufficient validation.

Requests go through the native Workers AI binding rather than the arbitrary server-profile proxy. The binding is omitted from the default local environment so MiniMax and room development do not require a Cloudflare login; `dev:cloudflare-ai` enables the production binding when authenticated testing is needed. The lobby keeps all five profiles visible but prevents assigning a role-limited model to an incompatible timeline seat.

### Additional providers

Each additional record is an allow-listed endpoint/model plus a key stored as the `SERVER_AI_PROFILES_JSON` Worker secret.

```bash
pnpm --filter @drawguessai/worker exec wrangler secret put SERVER_AI_PROFILES_JSON --env production
```

Example secret value:

```json
[
  {
    "profile": {
      "id": "server-vision",
      "label": "Hosted vision model",
      "protocol": "openai-compatible",
      "execution": "server",
      "baseUrl": "https://provider.example/v1",
      "model": "vision-model",
      "capabilities": {
        "vision": true,
        "structuredOutput": "json-schema",
        "observationMode": "checkpoint",
        "maxObservationPasses": 1,
        "drawingPlanMode": "inline",
        "supportedRoles": ["prompt", "draw", "guess", "review"]
      },
      "secretRef": "server-vision",
      "enabled": true
    },
    "apiKey": "use-a-real-secret-here"
  }
]
```

The server route accepts only a built-in or configured profile ID and only for the authenticated executor of the current `jobId`. It is not a general URL forwarder.

## Output contract

AI output contains exactly one of an optional private structured drawing plan, `commands`, `guess`, `prompt`, or a public post-game `review`, plus confidence and a short reaction. It never asks for or exposes hidden reasoning. Fast mode settles a compact composition privately and returns drawing commands immediately; detailed mode first creates a scene plan with stable object IDs, bounds, key features, and relationships. Rendering can use freehand strokes or the safe `line`, `polyline`, filled `polygon`, `rect`, `circle`, `ellipse`, `arc`, cubic `curve`, and structured `path` DSL with bounded transforms. AI-only source commands may omit the common pen, black, width-8, and zero-offset style fields and may use compact `[x,y]` pairs; the adapter restores the defaults before public validation. Every pen mark gets a subtle thin-thick-thin human pressure profile by default. An optional bounded `widthProfile` moves the pressure peak and makes the start/end taper asymmetric, so the model controls both variation and direction. The adapter compiles every primitive into a validated closed, optionally filled stroke before it leaves the executor. Compatible-provider aliases and numeric strings are normalized, including MiniMax's conventional path-segment `type`/`end` names and common mood labels for the fixed reaction set. Each drawing command is then validated independently: an unsupported or malformed command is skipped while valid marks continue to render. The adapter records a bounded private marker containing the command index, id, type, and validation error. When an observation pass remains, that marker is returned with the rendered image and surviving vector data so the model can restore the missing feature without replaying valid marks. These private markers are removed before room events and replay serialization. Inspection receives the rendered image, the optional retained plan, and only the active normalized vector primitives from preceding passes, then independently chooses an unrestricted in-budget patch, broad revision, or clear-and-redraw. Intentional overlap, retracing, erasing, and thickening are preserved; no geometry deduplication is applied. The default room keeps the expanded 120-stroke, 12-color, and 180-second AI drawing budget while returning correction behavior to one visual inspection and three undos. Setting room observations to zero makes drawing one-shot; one or two means that many rendered-image inspection and revision requests after the initial draft. The effective count is capped by the assigned model's vision capability, checkpoint mode, profile maximum, and the remaining turn deadline. The lobby resends its current controlled rule state immediately before start, so the latest value applies even if the separate Save button was not pressed. Guess, prompt, and review jobs always use zero observation passes. Live turn reactions are first-person, spontaneous, and spoiler-free: they may brag or complain but may not name or describe the answer, guess, subject, visible objects, shapes, colors, counts, or relationships. Exact answer leakage is rejected and repaired before publication. Reviews receive the exact original prompt, final result, start-to-final match marker, a compact actor/role ledger, every drawing-to-guess handoff, and earlier table talk. They are encouraged to stay around one or two sentences, but this is a style recommendation rather than a hard sentence or word limit. Every successful provider review must include one to three honest directed emoji interactions bound to an exact actor and turn; the adapter rejects role-swapped claims and positive reactions to misses. The final table aggregates valid directed review actions and other-player live reactions into best-player, worst-player, and overall-rating results. Final room and replay data remain bounded, quantized, deterministic, and free of arbitrary SVG or executable content.

Output budgets are role-specific rather than universally set to 8192 tokens: compact prompt and guess jobs use 512, reviews 384, optional scene plans 1024, inspection deltas 4096, and initial rendering 6144. Fast mode removes the separate plan round trip, compact source commands reduce coordinate tokens, inspection serializes active primitives instead of the full undo history, vision input uses a 640 x 480 WebP snapshot with a PNG fallback, and ordered preview frames accelerate as the drawing queue grows. These changes have little or no effect on the accepted drawing detail. By contrast, reducing the 120-stroke allowance, removing the default visual inspection, shrinking the render-token ceiling, or shortening the 180-second safety deadline can directly reduce quality or reliability and is intentionally avoided. The safety deadline only caps waiting; raising or lowering it does not make a healthy model generate faster.

## Failure fallback

The adapter repairs an invalid non-drawing response once. A partially valid drawing proceeds immediately with its surviving visible commands; malformed commands do not consume an immediate full-response retry. If every command is unusable or the surviving result is blank, the initial drawing still gets up to four attempts within the same deadline. A parsed drawing that breaks the combined palette or canvas budget gets compact feedback and up to four corrected candidate attempts per pass, also within that original deadline. If all attempts still produce no active valid content, the executor reports a public-safe error code and the Durable Object ends the session in `failed`; it never stores a finish-only AI drawing or silently advances a blank turn. If a later drawing inspection fails, already validated strokes from the first pass are retained. Guessing still uses a neutral "I have no idea" fallback, reviews leave the table on failure, and generated prompts get up to three attempts before the curated word bank is used.

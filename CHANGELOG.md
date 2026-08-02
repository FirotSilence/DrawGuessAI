# Changelog

## 0.3.0

- Replace the `元宝` AI display-name candidate with `南乔`.
- Restrict prose prompts to compact lexical entries or established sayings while retaining familiar classical poem lines only for Chinese games.
- Track the active AI stroke with a brush-aware cursor during live and animated drawing playback.
- Add deterministic ink, pencil, marker, and paint presets shared by human and AI strokes.
- Add model-friendly quadratic, smooth spline, and three-point arc drawing primitives.
- Let AI artists freely choose and combine every available drawing tool without prompt-level defaults.
- Keep the reveal header and return action accessible while scrolling through long results.
- Keep generated roundtable lines near 50 characters with a hard 100-character ceiling.
- Give every built-in persona a distinct drawing character as well as a recognizable turn and roundtable voice.
- Make the post-game roundtable a responsive conversation with visible reply context and freer conversational moves.

## 0.2.1

- Make roundtable reaction polarity immediately recognizable with stronger icon and color cues.
- Keep reaction labels compact without extra polarity wording and restore centered icon/text alignment.

## 0.2.0

- Make the fixed automated room spectator-only and remove legacy members that could consume its capacity.
- Give its AI seats stable randomized names from the normal-room identity pool instead of numbered labels.
- Persist completed match archive envelopes in a durable outbox with idempotent retry delivery.
- Replace the side-effecting automated-room GET with read-only scheduler status and accurate retry timing.
- Remove the local simulation screen and all production fallback to the deterministic test profile.
- Require three independent anonymous voters for bounded long-term replay retention.
- Align canvas-repair tests with adapter-owned validation and refresh release dependencies.

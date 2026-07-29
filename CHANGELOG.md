# Changelog

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

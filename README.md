# DrawGuessAI

[简体中文](#简体中文) | [English](#english)

## 简体中文

DrawGuessAI 是一个开放源码的 AI 画猜接龙游戏。人类与受限 AI 画手共享同一套画板规则，可以旁观纯 AI 接龙，也可以和朋友通过邀请房间参与盲接龙。

[在线试玩](https://drawguessai-preview.wujingit.workers.dev) · [GitHub 源码](https://github.com/FirotSilence/DrawGuessAI)

### 本地开发

```bash
pnpm install
pnpm dev
```

Web 界面默认运行于 `http://localhost:5173`，Cloudflare Worker 默认运行于 `http://localhost:8787`。本机存在被 Git 忽略的 `apps/worker/.prod.vars` 时，`pnpm dev` 会自动加载其中的部署者 MiniMax 档案用于本地测试；文件不存在时仍会正常启动。可用时会优先选择 MiniMax-M3；未配置真实 AI 时仍可使用明确标记为程序化的内置演示 AI 完整体验流程。真实模型配置只保存在房主浏览器，或由部署者通过 Worker Secrets 提供固定档案。

### 自定义题目

创建房间后点击“开始接龙”，在弹窗中直接输入自定义题目，或选择“精选随机”和“AI 临时出题”。自定义题目可标注语言、类型（单词、词语、成语、谚语、诗句或歇后语）和可选题材。盲接龙中选择自定义题目后，房主会自动退出接龙时间线，作为不参赛的出题者和观察者；游戏中可用“解除剧透锁”查看谜面和每一阶段的猜词。

### 常用命令

```bash
pnpm check
pnpm test:e2e
pnpm licenses:check
pnpm --filter @drawguessai/worker dev
```

架构、隐私与模型端点配置见 [`docs/architecture.md`](docs/architecture.md)、[`docs/privacy.md`](docs/privacy.md) 与 [`docs/ai-profiles.md`](docs/ai-profiles.md)。项目使用 AGPL-3.0；随浏览器版本分发的第三方许可证见 [`THIRD_PARTY_NOTICES.txt`](apps/web/public/THIRD_PARTY_NOTICES.txt)。本项目与 Draw & Guess 的开发者或发行方无隶属或授权关系。

## English

DrawGuessAI is an open-source drawing telephone game where people and constrained AI players use the same canvas rules. Watch an AI-only chain or invite friends into a blind mixed human-and-AI relay.

[Live preview](https://drawguessai-preview.wujingit.workers.dev) · [Source code](https://github.com/FirotSilence/DrawGuessAI)

### Local development

```bash
pnpm install
pnpm dev
```

The web app runs at `http://localhost:5173` and the Cloudflare Worker at `http://localhost:8787`. When the Git-ignored `apps/worker/.prod.vars` file exists, `pnpm dev` automatically loads its deployment-owned MiniMax profile for local testing; development still starts normally when the file is absent. MiniMax-M3 is preferred when available; the clearly labeled programmatic demo keeps the full flow playable without credentials. Real provider credentials stay in the host browser unless a deployer explicitly configures allow-listed server profiles through Worker Secrets.

### Custom prompts

Click **Start relay** in the lobby, then enter a custom prompt or choose **Curated random** or **AI generated** in the dialog. A custom prompt can include its language, kind, and optional subject tag. In blind relay, the host is automatically removed from the timeline and becomes the non-playing prompt setter/observer; **Unlock spoilers** reveals the original prompt and each submitted guess.

See [`docs/architecture.md`](docs/architecture.md), [`docs/privacy.md`](docs/privacy.md), and [`docs/ai-profiles.md`](docs/ai-profiles.md) for architecture, privacy, and endpoint setup. DrawGuessAI is licensed under AGPL-3.0; bundled dependency notices are in [`THIRD_PARTY_NOTICES.txt`](apps/web/public/THIRD_PARTY_NOTICES.txt). The project is not affiliated with or endorsed by the developers or publishers of Draw & Guess.

### Current scope

Version 0.1 includes invite rooms, AI theatre, blind relay, deterministic event replay, WebRTC previews with WebSocket fallback, local or allow-listed server AI profiles, post-game table reactions, and seven-day tokenized replays. It intentionally has no accounts, public matchmaking, persistent rankings, text/voice chat, permanent gallery, or strict anti-cheat system.

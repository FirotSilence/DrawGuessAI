# Privacy and threat model / 隐私与威胁模型

## Browser credentials / 浏览器密钥

Custom provider keys default to `sessionStorage`. They enter IndexedDB only after the user enables “Remember on this device”. A model profile contains a `secretRef`, never the key itself. Room creation, room WebSocket messages, DataChannels, replays, and application logs serialize public profiles only. A browser-owned provider request is sent directly from the Dedicated Worker to that provider; deployment-owned profiles send their key only from Worker Secrets to the allow-listed provider.

自定义模型密钥默认只进入当前标签页的 `sessionStorage`；只有主动勾选“记住”后才写入 IndexedDB。模型档案只有 `secretRef`，不存在密钥字段。房间 API、WebSocket、DataChannel、Worker、回放与应用日志都只序列化公开档案。

The selected AI provider receives the prompt or canvas needed for that turn. Browser extensions, injected scripts, the endpoint itself, and a person with developer tools on the executor browser may inspect those requests. Use a separate, limited key and a trusted endpoint.

After the relay, each review-capable assigned AI may receive a compact text summary containing the original prompt, submitted guesses, final result, the actor/role ledger, all drawing-to-guess handoffs, and earlier public persona reviews. A vision-capable reviewer that guessed directly after a human drawer may also receive that specific human drawing, clearly attributed to its owner; other review images are not sent. The resulting public review, score, reply target, and directed fixed-reaction actions are stored in the room replay.

Host-authored persona names, descriptions, and prompts are room configuration rather than secrets. They are synchronized to room participants, stored with the temporary room metadata, and sent to the selected AI provider when that persona acts. The custom display name is part of the public timeline and replay; the description and prompt text are not included in the replay payload. The editor warns players not to enter keys or other secrets.

所选 AI 服务会收到当前回合所需的题目或画布。浏览器扩展、注入脚本、模型端点，以及能打开执行者开发者工具的人，理论上都能查看请求。请使用独立、限额且可信的密钥。

接龙结束后，每个支持点评的已分配 AI 可能会收到一份精简文本摘要，其中包含原始谜面、各棒猜词、最终结果、玩家与回合身份表、全部“作画到猜词”的交接结果和此前已公开的角色点评。若点评者支持看图，且它紧接在一名人类画手之后猜图，还可能收到这一幅明确标注作者的人类画作；不会发送其他点评图片。生成的公开点评、评分、回应对象和定向快捷反应会写入房间回放。

## Multiplayer transport / 多人传输

WebRTC may expose network addresses to room peers. A deployer can configure Cloudflare TURN and the host can select relay-only mode. TURN credentials are generated per authenticated room member with a short lifetime; long-lived TURN credentials are never returned to the browser.

WebRTC 可能向同房间对端暴露网络地址。部署者可配置 Cloudflare TURN，并允许房主选择仅中继模式。浏览器只能获得针对已认证成员签发的短期凭据，长期 TURN 密钥不会下发。

## Server data / 服务端数据

The room stores participant display names, game configuration, commands, guesses, fixed reactions, connection state, and event metadata. It does not need accounts, email addresses, uploaded images, provider request bodies, or browser-owned keys. Canvas images used for AI are rendered transiently in the executor and are not written to room storage.

房间会保存昵称、规则、画板命令、猜测、固定反应、连接状态和事件元数据；不会要求账号、邮箱、上传图像、模型请求正文或浏览器自有密钥。AI 使用的画布图像只在执行端临时渲染，不写入房间存储。

Completed rooms are available only through an unguessable replay token and expire after the configured period, seven days by default. Reconnect and host tokens are carried in browser session storage and authenticated WebSocket subprotocol/API fields, not query strings or replay data. This is private-by-link rather than end-to-end encryption. Anyone who has the replay URL can view it until expiry.

The featured replay linked from the README is a deliberately selected static public sample shipped with the release assets, so it is not subject to Durable Object expiry. It contains only already-public game state and events, with no provider key, endpoint, request body, host token, or reconnect token. All ordinary room replays still follow the configured retention period.

README 中的精选回放是一个明确选取、随发布资源一同分发的静态公开样例，因此不受 Durable Object 到期清理影响。它只包含该局已经公开的游戏状态与事件，不包含模型密钥、端点、请求正文、房主令牌或重连令牌。除此之外，普通房间回放仍按配置的保留期到期删除。

## Non-goals / 非目标

Version 0.1 does not promise strict anti-cheat protection, anonymity from other WebRTC peers, encrypted replay content beyond TLS, provider privacy, or protection from a compromised browser/deployment.

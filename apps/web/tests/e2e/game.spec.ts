import { expect, test, type Locator, type Page } from "@playwright/test";

async function exposeMockServerMiniMax(page: Page) {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as {
      serverAiProfiles: Array<Record<string, unknown>>;
    };
    if (!config.serverAiProfiles.some((profile) => profile.id === "server-minimax-m3")) {
      config.serverAiProfiles.push({
        id: "server-minimax-m3",
        label: "MiniMax · MiniMax-M3 (test)",
        execution: "server",
        capabilities: {
          vision: true,
          structuredOutput: "none",
          observationMode: "checkpoint",
          maxObservationPasses: 2,
          drawingPlanMode: "inline",
          supportedRoles: ["prompt", "draw", "guess", "review"]
        }
      });
    }
    await route.fulfill({ response, json: config });
  });
}

async function assignAllAiSeats(page: Page, profileId: string) {
  const modelSelects = page.locator(".ai-seat-control .seat-model-select");
  await expect(modelSelects).not.toHaveCount(0);
  await page.getByLabel(/Model for bulk replacement|批量替换使用的模型/).selectOption(profileId);
  await page.getByRole("button", { name: /Replace in bulk|批量替换/ }).click();
  await expect
    .poll(() =>
      modelSelects.evaluateAll(
        (selects, expected) =>
          selects.every((select) => (select as HTMLSelectElement).value === expected),
        profileId
      )
    )
    .toBe(true);
}

async function createRoom(page: Page, name: string, mode: "theatre" | "blind" = "theatre") {
  await page.goto("/");
  await page.getByLabel(/Your name|你的名字/).fill(name);
  if (mode === "blind") await page.getByRole("button", { name: /Blind relay|盲接龙/ }).click();
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await expect(page).toHaveURL(/\?room=/);
  await assignAllAiSeats(page, "demo");
  return (await page.locator(".room-code-block strong").textContent())!.trim();
}

async function joinRoom(
  page: Page,
  roomCode: string,
  name: string,
  joinAs: "player" | "spectator" = "player"
) {
  await page.goto(`/?room=${roomCode}`);
  await page.getByLabel(/Your name|你的名字/).fill(name);
  if (joinAs === "spectator") {
    await page.getByRole("button", { name: /Spectator|观察者/ }).click();
  }
  await page.getByRole("button", { name: /Enter room|进入房间/ }).click();
  await expect(page.locator(".room-code-block strong")).toHaveText(roomCode);
}

async function startRelay(page: Page) {
  await page.getByRole("button", { name: /Start relay|开始接龙/ }).click();
  const dialog = page.getByRole("dialog", { name: /Choose this game's prompt|选择本局题目/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Curated random|精选随机/ }).click();
}

async function openAdvancedOptions(page: Page) {
  const button = page.getByRole("button", { name: /Advanced options|高级选项/ });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}

async function randomizeActorIntoFirstSlot(page: Page, actorName: string) {
  const firstSlot = page.locator(".timeline-slot").first();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await firstSlot.textContent())?.includes(actorName)) return;
    await page.getByRole("button", { name: /Randomize order|随机排位/ }).click();
    await page.waitForTimeout(80);
  }
  await expect(firstSlot).toContainText(actorName);
}

async function paintedPixelsIn(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index] !== 247 || pixels[index + 1] !== 248 || pixels[index + 2] !== 250) {
        count += 1;
      }
    }
    return count;
  });
}

async function paintedPixels(page: Page): Promise<number> {
  return paintedPixelsIn(page.locator(".play-surface canvas"));
}

async function actWhenNeeded(page: Page) {
  const editable = page.locator("canvas.is-editable");
  if (await editable.isVisible().catch(() => false)) {
    const box = await editable.boundingBox();
    if (box !== null) {
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.25, { steps: 8 });
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 8 });
      await page.mouse.up();
      await page.getByRole("button", { name: /Finish|完成/ }).click();
      return true;
    }
  }
  const guess = page.getByPlaceholder(/What is this drawing|这幅画是什么/);
  if (await guess.isVisible().catch(() => false)) {
    await guess.fill("a very ambitious public ceremony");
    await page.getByRole("button", { name: /Submit guess|提交猜测/ }).click();
    return true;
  }
  return false;
}

test("home is responsive and the sample canvas has pixels", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("DrawGuessAI").first()).toBeVisible();
  await expect(page.locator(".room-tool")).toBeVisible();
  await expect(page.locator(".recent-matches-bar")).toBeVisible();
  const sourceLink = page.getByRole("link", { name: /Source code|源码/ }).first();
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", "https://github.com/FirotSilence/DrawGuessAI");
  const nameInput = page.getByLabel(/Your name|你的名字/);
  await expect(nameInput).not.toHaveValue("");
  const generatedName = await nameInput.inputValue();
  await expect(page.locator(".seat-setup")).toHaveCount(0);
  if (testInfo.project.name !== "mobile-chromium") {
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.reload();
  await expect(nameInput).toHaveValue(generatedName);
  const paintedPixels = await page
    .locator("canvas")
    .first()
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (context === null) return 0;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index] !== 247 || pixels[index + 1] !== 248 || pixels[index + 2] !== 250)
          count += 1;
      }
      return count;
    });
  expect(paintedPixels).toBeGreaterThan(100);
  await page.screenshot({ path: `work/qa/home-${testInfo.project.name}.png`, fullPage: true });
});

test("the automated room opens its latest replay and joins without a peer signalling error", async ({
  page,
  request
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.setExtraHTTPHeaders({
    "cf-connecting-ip": `2001:db8:${crypto
      .randomUUID()
      .replaceAll("-", "")
      .match(/.{4}/g)!
      .slice(0, 6)
      .join(":")}`
  });
  await expect
    .poll(
      async () => {
        await request.get("http://127.0.0.1:43174/cdn-cgi/handler/scheduled");
        const response = await request.get("http://127.0.0.1:43174/api/automated-room/status");
        const status = (await response.json()) as {
          phase?: string;
          replayToken?: string;
        };
        return status.phase === "complete" && status.replayToken?.startsWith("MACH8888.") === true;
      },
      { timeout: 60_000, intervals: [500, 1_000] }
    )
    .toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: /Watch AI room|旁观 AI 挂机房/ }).click();

  await expect(page).toHaveURL(/\?replay=MACH8888\./);
  await expect(page.locator(".reveal-screen")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".postgame-reviews")).toBeVisible();
  await expect(page.locator(".persona-review")).toHaveCount(8);
  const automatedNames = await page.locator(".reveal-step > header > strong").allTextContents();
  expect(automatedNames).toHaveLength(8);
  expect(new Set(automatedNames).size).toBe(8);
  expect(automatedNames.every((name) => !/^AI\s*#?\d+$/i.test(name))).toBe(true);
  const likeButton = page.locator(".replay-like-button");
  await expect(likeButton).toBeVisible();
  await likeButton.click();
  await expect(likeButton).toHaveAttribute("aria-pressed", "true");

  await page.goto("/?room=MACH8888");
  await page.getByLabel(/Your name|你的名字/).fill("Automated observer");
  await page.getByRole("button", { name: /Spectator|观察者/ }).click();
  await page.getByRole("button", { name: /Enter room|进入房间/ }).click();
  await expect(page.locator(".reveal-screen")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".postgame-reviews")).toBeVisible();
  await expect(page.locator(".persona-review")).toHaveCount(8);
});

test("the documented featured replay is bundled and remains playable", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/?replay=5FPPFTC3.ySGKoHUPi39iesa0pr2uKA");
  await expect(page.getByRole("heading", { name: "骑驴看唱本，走着瞧" })).toBeVisible();
  await expect(page.locator(".reveal-step")).toHaveCount(8);
  await expect(page.locator(".replay-footer")).toContainText(/Featured public replay|精选公开回放/);
  const firstReaction = page.locator(".reaction-sentiment").first();
  await expect(firstReaction).toBeVisible();
  expect((await page.locator(".reaction-sentiment").allTextContents()).join(" ")).not.toMatch(
    /\b(?:Positive|Negative)\b|正向|负向/
  );
  const reactionAlignment = await firstReaction.evaluate((element) => {
    const iconSlot = element.querySelector(".reaction-sentiment-icon")!;
    const icon = iconSlot.querySelector("svg")!;
    const copy = element.querySelector(".reaction-sentiment-copy")!;
    const label = copy.querySelector(".reaction-sentiment-kind")!;
    const centeredDelta = (outer: Element, inner: Element) => {
      const outerBox = outer.getBoundingClientRect();
      const innerBox = inner.getBoundingClientRect();
      return {
        x: Math.abs(innerBox.left + innerBox.width / 2 - (outerBox.left + outerBox.width / 2)),
        y: Math.abs(innerBox.top + innerBox.height / 2 - (outerBox.top + outerBox.height / 2))
      };
    };
    return {
      icon: centeredDelta(iconSlot, icon),
      label: centeredDelta(copy, label)
    };
  });
  expect(reactionAlignment.icon.x).toBeLessThanOrEqual(0.75);
  expect(reactionAlignment.icon.y).toBeLessThanOrEqual(0.75);
  expect(reactionAlignment.label.x).toBeLessThanOrEqual(0.75);
  expect(reactionAlignment.label.y).toBeLessThanOrEqual(0.75);
  await expect
    .poll(() => paintedPixelsIn(page.locator(".reveal-step canvas").first()))
    .toBeGreaterThan(100);
});

test("the first visit follows the browser language and remembers a manual choice", async ({
  browser
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:43173/");
  await expect(page.getByRole("button", { name: "开启房间" })).toBeVisible();

  await page.getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("button", { name: "Open room" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open room" })).toBeVisible();
  await context.close();
});

test("turn status labels align and UI numerals use the shared sans font", async ({ page }) => {
  await createRoom(page, "Type Host");
  await startRelay(page);

  const personaTag = page.locator(".active-persona-tag");
  const roleLabel = page.locator(".role-label");
  await expect(personaTag).toBeVisible();
  await expect(roleLabel).toBeVisible();

  const personaBox = await personaTag.boundingBox();
  const roleBox = await roleLabel.boundingBox();
  expect(personaBox).not.toBeNull();
  expect(roleBox).not.toBeNull();
  const centerDifference = Math.abs(
    personaBox!.y + personaBox!.height / 2 - (roleBox!.y + roleBox!.height / 2)
  );
  expect(centerDifference).toBeLessThanOrEqual(1);

  const fontFamilies = await page
    .locator("body, .turn-kicker, .timer-readout strong, .room-code-block strong")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontFamily));
  expect(new Set(fontFamilies).size).toBe(1);
  expect(fontFamilies[0]).not.toMatch(/monospace/i);
  expect(fontFamilies[0]).toMatch(/sans-serif/i);
});

test("room errors stay at the bottom without covering the game status", async ({
  page
}, testInfo) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (
          window as typeof window & {
            __drawguessRoomSocket?: WebSocket;
          }
        ).__drawguessRoomSocket = this;
      }
    };
  });
  await createRoom(page, "Error Placement Host");
  await startRelay(page);
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __drawguessRoomSocket?: WebSocket;
        }
      ).__drawguessRoomSocket?.readyState === WebSocket.OPEN
  );
  await page.evaluate(() => {
    (
      window as typeof window & {
        __drawguessRoomSocket?: WebSocket;
      }
    ).__drawguessRoomSocket?.send(JSON.stringify({ type: "invalid-test-message" }));
  });

  const banner = page.locator(".error-banner.is-game");
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const headerBox = await page.locator(".game-header").boundingBox();
  const viewport = page.viewportSize();
  expect(bannerBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bannerBox!.y).toBeGreaterThan(headerBox!.y + headerBox!.height);
  const bottomGap = viewport!.height - bannerBox!.y - bannerBox!.height;
  if (testInfo.project.name === "mobile-chromium") expect(bottomGap).toBeGreaterThanOrEqual(125);
  else expect(bottomGap).toBeLessThanOrEqual(20);
});

test("lobby decouples AI names from personas and confirms abandoning the room", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Lobby Host");

  await expect(page.getByRole("link", { name: /Source code|源码/ })).toHaveAttribute(
    "href",
    "https://github.com/FirotSilence/DrawGuessAI"
  );

  const names = page.locator(".ai-seat-identity strong");
  const before = await names.allTextContents();
  expect(new Set(before).size).toBe(before.length);
  await expect(page.locator(".prompt-source-row")).toHaveCount(0);
  const firstHandleBox = await page.locator(".timeline-slot .drag-handle").first().boundingBox();
  const firstRoleBox = await page.locator(".timeline-slot .timeline-role").first().boundingBox();
  expect(firstHandleBox).not.toBeNull();
  expect(firstRoleBox).not.toBeNull();
  expect(firstHandleBox!.x + firstHandleBox!.width).toBeLessThanOrEqual(firstRoleBox!.x);

  await expect(page.getByText(/Model for bulk replacement|批量替换使用的模型/)).toHaveCount(0);
  const bulkSelectBox = await page.locator(".ai-seat-bulk-controls select").boundingBox();
  const bulkButtonBox = await page
    .locator(".ai-seat-bulk-controls .secondary-button")
    .boundingBox();
  expect(bulkSelectBox).not.toBeNull();
  expect(bulkButtonBox).not.toBeNull();
  expect(Math.abs(bulkSelectBox!.y - bulkButtonBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bulkSelectBox!.height - bulkButtonBox!.height)).toBeLessThanOrEqual(1);

  const personas = page.locator(".seat-persona-select");
  await personas.nth(0).selectOption("deadpan");
  await personas.nth(1).selectOption("deadpan");
  await expect(personas.nth(0)).toHaveValue("deadpan");
  await expect(personas.nth(1)).toHaveValue("deadpan");
  await expect(page.locator(".ai-seat-identity .persona-tag").nth(0)).toHaveText(/Deadpan|冷面/);
  await expect(page.locator(".ai-seat-identity .persona-tag").nth(1)).toHaveText(/Deadpan|冷面/);
  expect(await names.allTextContents()).toEqual(before);

  await page.getByRole("button", { name: /Start relay|开始接龙/ }).click();
  const promptDialog = page.getByRole("dialog", {
    name: /Choose this game's prompt|选择本局题目/
  });
  await expect(promptDialog).toBeVisible();
  await expect(promptDialog.getByRole("button", { name: /Curated random|精选随机/ })).toBeVisible();
  await expect(
    promptDialog.getByRole("button", { name: /AI-generated prompt|AI 临时出题/ })
  ).toBeVisible();
  await page.screenshot({ path: "work/qa/prompt-choice-1440x900.png", fullPage: true });
  await promptDialog.getByRole("button", { name: /Close|关闭/ }).click();

  await page.locator(".lobby-back-button").click();
  const leaveDialog = page.getByRole("alertdialog", { name: /Abandon this game|是否放弃本局/ });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: /Cancel|取消/ }).click();
  await expect(page.locator(".lobby-screen")).toBeVisible();
  await page.locator(".lobby-back-button").click();
  await leaveDialog.getByRole("button", { name: /Abandon and return|放弃并返回/ }).click();
  await expect(page.locator(".home-screen")).toBeVisible();
  await expect(page).not.toHaveURL(/room=/);
});

test("leaving an invited room clears the stale join code", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const roomCode = await createRoom(host, "Host");
  await joinRoom(guest, roomCode, "Guest");

  await guest.locator(".lobby-back-button").click();
  await guest
    .getByRole("alertdialog", { name: /Abandon this game|是否放弃本局/ })
    .getByRole("button", { name: /Abandon and return|放弃并返回/ })
    .click();

  await expect(guest).not.toHaveURL(/room=/);
  await expect(guest.locator(".room-tool")).toHaveAttribute("aria-label", /Create room|创建房间/);
  await expect(guest.getByLabel(/Room code|房间码/)).toHaveCount(0);
  await expect(host.locator(".participant-list")).not.toContainText("Guest");
  await hostContext.close();
  await guestContext.close();
});

test("prompt choice dialog fits the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await createRoom(page, "Pocket Host");
  await page.getByRole("button", { name: /Start relay|开始接龙/ }).click();
  const dialog = page.getByRole("dialog", { name: /Choose this game's prompt|选择本局题目/ });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: "work/qa/prompt-choice-390x844.png", fullPage: false });
});

test("the prompt dialog can delegate the opening prompt to AI", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Prompt Delegate");
  await page.getByRole("button", { name: /Start relay|开始接龙/ }).click();
  await page
    .getByRole("dialog", { name: /Choose this game's prompt|选择本局题目/ })
    .getByRole("button", { name: /AI-generated prompt|AI 临时出题/ })
    .click();
  await expect(page.locator(".play-surface canvas")).toBeVisible({ timeout: 10_000 });
});

test("AI vision snapshots use a compact 4:3 image", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/");
  await page.addScriptTag({
    type: "module",
    content: `
      import { commandsToAiImageDataUrl } from "/src/lib/canvas-renderer.ts";
      const dataUrl = commandsToAiImageDataUrl([{
        type: "stroke",
        id: "vision-sample",
        tool: "pen",
        color: "#202124",
        width: 8,
        points: [{ x: 100, y: 100 }, { x: 900, y: 650 }],
        offsetMs: 0
      }]);
      const image = new Image();
      window.__drawguessAiSnapshot = new Promise((resolve, reject) => {
        image.onload = () => resolve({
          mediaType: dataUrl.slice(5, dataUrl.indexOf(";")),
          width: image.naturalWidth,
          height: image.naturalHeight,
          bytes: dataUrl.length
        });
        image.onerror = () => reject(new Error("AI snapshot could not be decoded"));
      });
      image.src = dataUrl;
    `
  });
  await page.waitForFunction(() => "__drawguessAiSnapshot" in window);
  const snapshot = await page.evaluate(
    () =>
      (
        window as unknown as {
          __drawguessAiSnapshot: Promise<{
            mediaType: string;
            width: number;
            height: number;
            bytes: number;
          }>;
        }
      ).__drawguessAiSnapshot
  );

  expect(["image/webp", "image/png"]).toContain(snapshot.mediaType);
  expect(snapshot).toMatchObject({ width: 640, height: 480 });
  expect(snapshot.bytes).toBeLessThan(100_000);
});

test("local CCSwitch preset completes a real model test", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium" || process.env.TEST_CCSWITCH !== "1");
  await page.goto("/");
  await page.locator(".home-header .icon-button").click();
  await page.getByRole("button", { name: /^CCSwitch/ }).click();
  await page.getByRole("button", { name: /Test (profile|connection)|测试连接/ }).click();
  const status = page.locator(".profile-status");
  await expect(status).toBeVisible({ timeout: 45_000 });
  await expect(status).not.toContainText(/AI test failed|Connection failed/i);
});

test("a vision profile test sends an actual image request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const requests: unknown[] = [];
  const requestHeaders: Record<string, string>[] = [];
  await page.route("http://127.0.0.1:8080/v1/chat/completions", async (route) => {
    const requestBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    requests.push(requestBody);
    requestHeaders.push(route.request().headers());
    const requestText = JSON.stringify(requestBody);
    const jobId = /Set jobId to exactly ([A-Za-z0-9_-]+)/.exec(requestText)?.[1] ?? "job";
    const hasImage = requestText.includes('"type":"image_url"');
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                hasImage
                  ? {
                      jobId,
                      status: "ok",
                      guess: "umbrella",
                      confidence: 0.9,
                      reaction: { kind: "clap", text: "I have an answer." }
                    }
                  : {
                      jobId,
                      status: "ok",
                      prompt: "riding a bicycle in the rain",
                      promptKind: "phrase",
                      promptTopic: "action",
                      confidence: 0.9,
                      reaction: { kind: "clap", text: "Ready." }
                    }
              )
            }
          }
        ]
      })
    });
  });

  await page.goto("/");
  await page.locator(".home-header .icon-button").click();
  const dialog = page.getByRole("dialog", { name: /Model profiles|模型档案/ });
  await dialog.getByLabel(/Profile name|档案名称/).fill("Vision test");
  await dialog.getByLabel(/Model name|模型名称/).fill("vision-model");
  await dialog.getByLabel(/API key|API 密钥/).fill("test-key");
  await dialog.getByLabel(/Authentication|鉴权方式/).selectOption("x-api-key");
  await expect(dialog.getByText(/Supported tasks|支持任务/)).toBeVisible();
  await dialog.getByLabel(/Roundtable review|圆桌点评/).uncheck();
  await dialog.getByRole("button", { name: /Test (profile|connection)|测试连接/ }).click();

  await expect(dialog.locator(".profile-status")).toContainText(
    /Vision request verified|看图请求已验证/
  );
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain('"type":"image_url"');
  expect(requestHeaders.every((headers) => headers["x-api-key"] === "test-key")).toBe(true);
  expect(requestHeaders.every((headers) => headers.authorization === undefined)).toBe(true);

  await dialog.getByRole("button", { name: /Save profile|保存档案/ }).click();
  await dialog.locator(".profile-row", { hasText: "Vision test" }).click();
  await expect(dialog.getByLabel(/Authentication|鉴权方式/)).toHaveValue("x-api-key");
  await expect(dialog.getByLabel(/Roundtable review|圆桌点评/)).not.toBeChecked();
});

test("local CCSwitch preset does not expose a pretend model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/");
  await page.locator(".home-header .icon-button").click();
  await page.locator(".profile-row", { hasText: "CCSwitch" }).click();
  await expect(page.getByLabel(/^Model name$|^模型名称$/)).toHaveCount(0);
  await expect(page.getByLabel(/^API key$|^API 密钥$/)).toHaveCount(0);
});

test("model profiles explain local credential handling and room rules start collapsed", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/");
  await page.locator(".home-header .icon-button").click();
  const dialog = page.getByRole("dialog", { name: /Model profiles|模型档案/ });
  await expect(dialog).toContainText(
    /custom model requests run only in this browser|自定义模型只由当前浏览器本地执行/i
  );
  await expect(dialog.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", /^https:\/\//);
  await dialog.getByRole("button", { name: /Close|关闭/ }).click();

  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  const advanced = page.getByRole("button", { name: /Advanced options|高级选项/ });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: /Room rules|房间规则/ })).toHaveCount(0);
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: /Room rules|房间规则/ })).toBeVisible();
});

test("a retrying local model request is identified while it is in flight", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  let requestCount = 0;
  await page.route("**/ccswitch/v1/messages", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.abort("failed");
      return;
    }
    const requestText = route.request().postData() ?? "";
    const jobId = /Set jobId to exactly ([A-Za-z0-9_-]+)/.exec(requestText)?.[1] ?? "job";
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              jobId,
              status: "ok",
              clearCanvas: false,
              commands: [
                {
                  type: "line",
                  id: "recovered-line",
                  color: "#202124",
                  start: [180, 180],
                  end: [760, 560]
                }
              ],
              confidence: 0.7,
              reaction: { kind: "confused", text: "I am still here." }
            })
          }
        ]
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  await startRelay(page);

  const activityTitle = page.locator(".ai-activity-title strong");
  await expect(activityTitle).toContainText(/Retrying model request|模型请求重试中/, {
    timeout: 8_000
  });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect.poll(() => paintedPixels(page), { timeout: 8_000 }).toBeGreaterThan(0);
});

test("direct DeepSeek environment preset completes a real model test", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium" || process.env.TEST_DEEPSEEK_DIRECT !== "1"
  );
  await page.goto("/");
  await page.locator(".home-header .icon-button").click();
  await page.getByRole("button", { name: /^DeepSeek · Direct/ }).click();
  await expect(page.getByLabel(/^Vision capable$|^支持看图$/)).toBeDisabled();
  await expect(page.getByLabel(/^API key$|^API 密钥$/)).toHaveCount(0);
  await page.getByRole("button", { name: /Test (profile|connection)|测试连接/ }).click();
  const status = page.locator(".profile-status");
  await expect(status).toBeVisible({ timeout: 45_000 });
  await expect(status).not.toContainText(/AI test failed|Connection failed/i);
});

test("four blank model responses stop the room with a model fault", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  let planCalls = 0;
  let drawingCalls = 0;
  await page.route("**/ccswitch/v1/messages", async (route) => {
    const requestText = route.request().postData() ?? "";
    const jobId = /Set jobId to exactly ([A-Za-z0-9_-]+)/.exec(requestText)?.[1] ?? "job";
    const planning = requestText.includes("Produce the structured scene plan only");
    const result = planning
      ? {
          jobId,
          status: "ok",
          drawingPlan: {
            summary: "one central bicycle",
            keyFeatures: ["two wheels"],
            objects: [
              {
                id: "bicycle",
                label: "bicycle",
                bounds: { x: 180, y: 170, width: 640, height: 420 },
                features: ["two wheels"]
              }
            ],
            relationships: []
          },
          confidence: 0.8,
          reaction: { kind: "spark", text: "Plan ready." }
        }
      : {
          jobId,
          status: "ok",
          clearCanvas: false,
          commands: [{ type: "finish", id: "finish", offsetMs: 0 }],
          confidence: 0.1,
          reaction: { kind: "confused", text: "Blank." }
        };
    if (planning) planCalls += 1;
    else drawingCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  await startRelay(page);

  await expect(page.locator(".model-fault-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".model-fault-screen")).toContainText(
    /模型没有画出有效内容|model produced no valid drawing/i
  );
  await expect(page.locator(".model-fault-screen code")).toHaveText("empty-drawing");
  expect(planCalls).toBe(0);
  expect(drawingCalls).toBe(4);
  await expect(page.locator(".reveal-screen")).toHaveCount(0);
  await page.screenshot({ path: "work/qa/model-fault-1440x900.png", fullPage: true });
});

test("an exhausted MiniMax Token Plan window is not reported as account quota", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  let requestCount = 0;
  await page.route("**/ccswitch/v1/messages", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"
        }
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  await startRelay(page);

  const fault = page.locator(".model-fault-screen");
  await expect(fault).toBeVisible({ timeout: 15_000 });
  await expect(fault).toContainText(/当前时段额度暂不可用|current usage window is unavailable/i);
  await expect(fault).toContainText(/MiniMax.*2056/i);
  await expect(fault).not.toContainText(/模型没有画出有效内容|produced no valid drawing/i);
  await expect(fault).not.toContainText(/模型额度已耗尽|model quota is exhausted/i);
  await expect(fault.locator("code")).toHaveText("token-plan-window-exhausted");
  expect(requestCount).toBe(1);
});

test("canvas-limit output is retried while accepted actions draw progressively", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  let firstDrawJobId = "";
  let initialCandidateCalls = 0;
  let firstInspectionCalls = 0;
  let sawAdapterRepair = false;
  let sawCanvasLimitCode = false;
  let sawSkippedCommandFeedback = false;
  await page.route("**/ccswitch/v1/messages", async (route) => {
    const requestText = route.request().postData() ?? "";
    const jobId = /Set jobId to exactly ([A-Za-z0-9_-]+)/.exec(requestText)?.[1] ?? "job";
    const lowerRequest = requestText.toLowerCase();
    const guessing = requestText.includes("Name the scene shown in the image");
    let result: Record<string, unknown>;
    if (guessing) {
      result = {
        jobId,
        status: "ok",
        guess: "a tidy test scene",
        confidence: 0.7,
        reaction: { kind: "spark", text: "Readable enough." }
      };
    } else {
      if (firstDrawJobId === "") firstDrawJobId = jobId;
      const isFirstDraw = jobId === firstDrawJobId;
      const inspectionOne = requestText.includes("observation pass 1 of 2");
      const inspectionTwo = requestText.includes("observation pass 2 of 2");
      if (isFirstDraw && inspectionTwo) {
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      let commands: Record<string, unknown>[];
      if (inspectionTwo) {
        commands = [{ type: "finish", id: "finish" }];
      } else if (inspectionOne) {
        if (isFirstDraw) firstInspectionCalls += 1;
        if (isFirstDraw) {
          sawSkippedCommandFeedback ||=
            lowerRequest.includes("commands from the previous pass were skipped") &&
            lowerRequest.includes("skipped-detail");
        }
        commands = [
          {
            type: "line",
            id: "inspection-detail",
            color: isFirstDraw && firstInspectionCalls === 1 ? "#abcdef" : "#e94f64",
            start: [500, 100],
            end: [500, 650]
          }
        ];
      } else {
        if (isFirstDraw) initialCandidateCalls += 1;
        sawAdapterRepair ||= lowerRequest.includes("your previous response was invalid");
        sawCanvasLimitCode ||= lowerRequest.includes("color-not-allowed");
        const invalidColor = isFirstDraw && initialCandidateCalls === 1;
        commands = [
          ...Array.from({ length: invalidColor ? 1 : 7 }, (_, index) => ({
            type: "line",
            id: `line-${index}`,
            color: invalidColor ? "#abcdef" : "#202124",
            start: [120, 120 + index * 70],
            end: [880, 120 + index * 70]
          })),
          ...(isFirstDraw && initialCandidateCalls === 2
            ? [{ type: "mystery", id: "skipped-detail" }]
            : [])
        ];
      }
      result = {
        jobId,
        status: "ok",
        clearCanvas: false,
        commands,
        confidence: 0.8,
        reaction: { kind: "spark", text: "Actions ready." }
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  await openAdvancedOptions(page);
  const observationSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  await observationSetting.locator('input[type="number"]').fill("2");
  await page.getByRole("button", { name: /Save rules|保存规则/ }).click();
  await startRelay(page);

  const activity = page.locator(".ai-activity-panel");
  await expect(activity).toBeVisible({ timeout: 8_000 });
  await activity.locator("summary").click();
  await expect(activity.locator(".ai-activity-metrics")).toContainText(/2 planned|计划 2 次/);
  const pixelSamples: number[] = [];
  await expect
    .poll(
      async () => {
        const pixels = await paintedPixels(page);
        if (pixels > 0 && pixels !== pixelSamples.at(-1)) pixelSamples.push(pixels);
        return pixelSamples.length;
      },
      { timeout: 7_000, intervals: [50, 80, 120] }
    )
    .toBeGreaterThan(2);
  await expect.poll(() => initialCandidateCalls).toBe(2);
  await expect.poll(() => firstInspectionCalls).toBe(2);
  expect(sawAdapterRepair).toBe(true);
  expect(sawCanvasLimitCode).toBe(true);
  expect(sawSkippedCommandFeedback).toBe(true);
  await expect(activity.locator(".ai-activity-metrics")).toContainText("2/2", {
    timeout: 8_000
  });
  await expect(page.locator(".model-fault-screen")).toHaveCount(0);
});

test("AI seats expose twelve configurable persona labels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Persona Host");
  const personaControls = page.locator(".ai-seat-control .seat-persona-select");
  await expect(personaControls).toHaveCount(8);
  const assignedPersonas = await personaControls.evaluateAll((controls) =>
    controls.map((control) => (control as HTMLSelectElement).value)
  );
  expect(new Set(assignedPersonas).size).toBe(8);
  const personaSelect = page.locator(".ai-seat-control .seat-persona-select").first();
  await expect(personaSelect.locator("option")).toHaveCount(12);
  await personaSelect.selectOption("poet");
  await expect(page.locator(".ai-seat-control").first()).toContainText(/Poet|画外诗人/);
  await expect(page.locator(".timeline-slot").first()).toContainText(/Poet|画外诗人/);
  await page.screenshot({ path: "work/qa/personas-lobby-1440x900.png", fullPage: true });
});

test("host can edit a persona name and its turn and roundtable prompts", async ({
  page
}, testInfo) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    (
      window as typeof window & {
        __personaAiJobs?: unknown[];
      }
    ).__personaAiJobs = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          try {
            const message = JSON.parse(event.data) as { type?: string; job?: unknown };
            if (message.type === "ai.job") {
              (
                window as typeof window & {
                  __personaAiJobs?: unknown[];
                }
              ).__personaAiJobs?.push(message.job);
            }
          } catch {
            // Ignore non-JSON WebRTC signaling payloads.
          }
        });
      }
    };
  });
  await createRoom(page, "Persona Editor Host");

  await page
    .getByRole("button", { name: /Edit persona|编辑人设/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /Edit persona|编辑人设/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Persona name|人设名称/).fill("街头派");
  await dialog.getByLabel(/Persona description|人设简介/).fill("直爽，认真，胜负心强");
  await dialog
    .getByLabel(/Turn prompt|回合提示词/)
    .fill("Use lively curved marks, keep the answer recognizable, and speak plainly.");
  await dialog
    .getByLabel(/Roundtable prompt|圆桌提示词/)
    .fill("React like a competitive friend and comment on one exact handoff.");
  await page.screenshot({
    path: `work/qa/persona-editor-${testInfo.project.name}.png`,
    fullPage: true
  });
  await dialog.getByRole("button", { name: /Save persona|保存人设/ }).click();

  await expect(page.locator(".ai-seat-control .persona-tag").first()).toHaveText("街头派");
  await expect(page.locator(".timeline-slot .timeline-persona").first()).toHaveText("街头派");
  await startRelay(page);
  await expect(page.locator(".active-persona-tag")).toHaveText("街头派");
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __personaAiJobs?: Array<{ personaCustomization?: { name?: string } }>;
        }
      ).__personaAiJobs?.some((job) => job.personaCustomization?.name === "街头派") === true
  );
});

test("host can replace every compatible AI seat model in one action", async ({
  page
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  const modelSelects = page.locator(".ai-seat-control .seat-model-select");
  await expect(modelSelects).toHaveCount(8);

  await page.getByLabel(/Model for bulk replacement|批量替换使用的模型/).selectOption("demo");
  await page.getByRole("button", { name: /Replace in bulk|批量替换/ }).click();

  await expect
    .poll(() =>
      modelSelects.evaluateAll((selects) =>
        selects.every((select) => (select as HTMLSelectElement).value === "demo")
      )
    )
    .toBe(true);
  await expect(page.locator(".ai-seat-bulk-status")).toContainText(
    /8.*0|8 compatible.*0 incompatible/i
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({
    path: `work/qa/bulk-model-${testInfo.project.name}.png`,
    fullPage: false
  });
});

test("lobby rule drafts survive unrelated seat snapshots", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await openAdvancedOptions(page);
  const observationSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  const input = observationSetting.locator('input[type="number"]');
  await input.fill("2");
  await page.locator(".ai-seat-control .seat-model-select").first().selectOption("ccswitch-local");
  await page.waitForTimeout(300);

  await expect(input).toHaveValue("2");
});

test("host can hide the subject hint before starting", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Hard Mode Host");
  await openAdvancedOptions(page);
  const topicHint = page.getByLabel(/Subject hint|题材标签/);
  await expect(topicHint).toBeChecked();
  await topicHint.uncheck();
  await page.screenshot({ path: "work/qa/topic-hint-lobby-1440x900.png", fullPage: true });
  await page.getByRole("button", { name: /Save rules|保存规则/ }).click();
  await startRelay(page);
  await expect(page.locator(".game-prompt-spec .prompt-tags > span")).toHaveCount(2);
});

test("mobile prompt spec fits the extra subject hint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await createRoom(page, "Pocket Scholar");
  await startRelay(page);
  const promptSpec = page.locator(".game-prompt-spec");
  await expect(promptSpec.locator(".prompt-tags > span")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: "work/qa/topic-hint-390x844.png", fullPage: false });
});

test("CCSwitch-only seats use MiniMax for drawing and vision guessing", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium" || process.env.TEST_CCSWITCH_MINIMAX !== "1"
  );
  test.setTimeout(480_000);
  await page.goto("/");
  await page.getByLabel(/Your name|你的名字/).fill("MiniMax Host");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  const start = page.getByRole("button", { name: /Start relay|开始接龙/ });
  await expect(start).toBeEnabled();
  await start.click();
  await page
    .getByRole("dialog", { name: /Choose this game's prompt|选择本局题目/ })
    .getByRole("button", { name: /Curated random|精选随机/ })
    .click();
  await expect(page.locator(".play-surface canvas")).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => page.locator(".reaction-note").count(), { timeout: 90_000 })
    .toBeGreaterThan(1);
  await expect(page.locator(".reaction-note").nth(0)).not.toContainText(
    "Technically, this is a drawing."
  );
  await expect(page.locator(".reaction-note").nth(1)).not.toContainText(
    /A bold direction\. I support it\.|方向非常大胆，我支持。/
  );
  await expect.poll(() => paintedPixels(page), { timeout: 30_000 }).toBeGreaterThan(100);
  await expect(page.locator(".reveal-screen")).toBeVisible({ timeout: 360_000 });
  const drawings = page.locator(".reveal-step.step-draw canvas");
  await expect(drawings).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    expect(await paintedPixelsIn(drawings.nth(index))).toBeGreaterThan(100);
  }
});

test("CCSwitch MiniMax honors two requested inspection rounds", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium" || process.env.TEST_CCSWITCH_MINIMAX !== "1"
  );
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "ccswitch-local");
  await openAdvancedOptions(page);
  const observationSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  await observationSetting.locator('input[type="number"]').fill("2");
  await page.getByRole("button", { name: /Save rules|保存规则/ }).click();
  await startRelay(page);

  await expect(page.locator(".ai-activity-metrics")).toContainText("2/2", { timeout: 105_000 });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(page.locator(".canvas-playback-status")).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => paintedPixels(page), { timeout: 20_000 }).toBeGreaterThan(100);
  await page.screenshot({ path: "work/qa/minimax-vector-playback-1440x900.png", fullPage: true });
  await expect(page.locator(".canvas-playback-status")).toBeHidden({ timeout: 30_000 });
  await page.screenshot({ path: "work/qa/minimax-vector-final-1440x900.png", fullPage: true });
});

test("server MiniMax exposes the live inspection UX", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium" || process.env.TEST_SERVER_MINIMAX !== "1"
  );
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByLabel(/Your name|你的名字/).fill("Inspection Host");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  await assignAllAiSeats(page, "server-minimax-m3");
  await openAdvancedOptions(page);
  const observationSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  await observationSetting.locator('input[type="number"]').fill("2");
  await page.getByRole("button", { name: /Save rules|保存规则/ }).click();
  await startRelay(page);

  await expect(page.locator(".inspect-banner")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".ai-activity-panel")).toHaveAttribute("open", "");
  await expect(page.locator(".ai-activity-metrics")).toContainText("2/2", { timeout: 90_000 });
  await expect(page.locator(".canvas-playback-status")).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => paintedPixels(page), { timeout: 20_000 }).toBeGreaterThan(100);
  await page.screenshot({ path: "work/qa/minimax-inspect-1440x900.png", fullPage: true });
});

test("unsaved room observation changes still configure every requested inspection", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await exposeMockServerMiniMax(page);
  const jobs: Array<{
    jobId: string;
    role: string;
    observationIndex: number;
    observationLimit: number;
  }> = [];
  await page.route("**/api/server-ai/server-minimax-m3", async (route) => {
    const body = route.request().postDataJSON() as {
      job: { jobId: string; role: string; observationIndex: number; observationLimit: number };
    };
    const { job } = body;
    jobs.push({
      jobId: job.jobId,
      role: job.role,
      observationIndex: job.observationIndex,
      observationLimit: job.observationLimit
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jobId: job.jobId,
        status: "ok",
        commands:
          job.role === "draw"
            ? [
                {
                  type: "stroke",
                  id: `pass-${job.observationIndex}`,
                  tool: "pen",
                  color: "#202124",
                  width: 8,
                  points: [
                    { x: 180 + job.observationIndex * 30, y: 180 },
                    { x: 520 + job.observationIndex * 30, y: 460 }
                  ],
                  offsetMs: 0
                }
              ]
            : undefined,
        clearCanvas: job.role === "draw" ? false : undefined,
        guess: job.role === "guess" ? "an energetic mystery" : undefined,
        confidence: 0.7,
        reaction: { kind: "confused", text: "I need a moment after that." }
      })
    });
  });

  await page.goto("/");
  await page.getByLabel(/Your name|你的名字/).fill("Config Host");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  const seats = page.locator(".ai-seat-control .seat-model-select");
  await assignAllAiSeats(page, "server-minimax-m3");
  await openAdvancedOptions(page);
  const observationSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  await observationSetting.locator('input[type="number"]').fill("2");
  await expect(seats.first()).toHaveAttribute("data-observation-limit", "2");
  await startRelay(page);

  await expect.poll(() => jobs.find((job) => job.role === "draw")?.observationLimit).toBe(2);
  await expect
    .poll(() => jobs.some((job) => job.role === "draw" && job.observationIndex === 2), {
      timeout: 15_000
    })
    .toBe(true);

  jobs.length = 0;
  await page.goto("/");
  await page.getByLabel(/Your name|你的名字/).fill("Zero Pass Host");
  await page.getByRole("button", { name: /Open room|开启房间/ }).click();
  const zeroPassSeats = page.locator(".ai-seat-control .seat-model-select");
  await assignAllAiSeats(page, "server-minimax-m3");
  await openAdvancedOptions(page);
  const zeroPassSetting = page.locator(".numeric-setting", {
    hasText: /AI inspections|AI 观察次数/
  });
  await zeroPassSetting.locator('input[type="number"]').fill("0");
  await expect(zeroPassSeats.first()).toHaveAttribute("data-observation-limit", "0");
  await startRelay(page);
  await expect.poll(() => jobs.find((job) => job.role === "draw")?.observationLimit).toBe(0);
  const zeroPassJobId = jobs.find((job) => job.role === "draw")!.jobId;
  await page.waitForTimeout(2_000);
  expect(jobs.filter((job) => job.jobId === zeroPassJobId)).toHaveLength(1);
});

test("AI theatre completes and exports a versioned replay", async ({ page }, testInfo) => {
  test.skip(
    !["desktop-chromium", "desktop-firefox", "desktop-webkit"].includes(testInfo.project.name)
  );
  await createRoom(page, "Studio Host");
  await startRelay(page);
  await expect(page.getByRole("link", { name: /Source code|源码/ })).toHaveAttribute(
    "href",
    "https://github.com/FirotSilence/DrawGuessAI"
  );
  await expect(page.locator(".reaction-button.reaction-tone-positive")).toHaveCount(3);
  await expect(page.locator(".reaction-button.reaction-tone-negative")).toHaveCount(2);
  await expect(page.locator(".reaction-button.reaction-tone-neutral")).toHaveCount(1);
  const playbackStatus = page.locator(".canvas-playback-status");
  await expect(playbackStatus).toBeVisible({ timeout: 10_000 });
  const initialPaintedPixels = await paintedPixels(page);
  await expect
    .poll(() => paintedPixels(page), { timeout: 4_000 })
    .toBeGreaterThan(initialPaintedPixels);
  const activity = page.locator(".ai-activity-panel");
  await expect(activity).toBeVisible();
  await activity.locator("summary").click();
  await expect(activity.locator(".ai-activity-disclosure")).toBeVisible();
  await page.screenshot({ path: "work/qa/ai-activity-1440x900.png", fullPage: true });
  await expect(page.locator(".reaction-note").first()).toContainText(
    /I may have just peaked|我这一下，多少有点神来之笔/,
    { timeout: 10_000 }
  );
  await expect(page.locator(".reveal-screen")).toBeVisible({ timeout: 50_000 });
  await expect(page.getByRole("link", { name: /Source code|源码/ })).toHaveAttribute(
    "href",
    "https://github.com/FirotSilence/DrawGuessAI"
  );
  await expect(page.locator(".reveal-step")).toHaveCount(8);
  await expect(page.locator(".persona-review")).toHaveCount(8, { timeout: 15_000 });
  await expect(page.locator(".persona-review.is-departed")).toHaveCount(8);
  await expect(page.locator(".persona-review").first()).toContainText(
    /AI had nothing to say and left the room|AI无言以对,已退出房间/
  );
  await expect(page.locator(".turn-contribution-preview.is-inline")).toHaveCount(8);
  await expect(page.locator(".review-score")).toHaveCount(0);
  await expect(page.locator(".review-action")).toHaveCount(0);
  const settlementButtons = page.getByRole("button", {
    name: /View results|查看结算/
  });
  await expect(settlementButtons).toHaveCount(2);
  await expect(settlementButtons.first()).toBeEnabled();
  await page.locator(".settlement-footer .settlement-trigger").click();
  const settlementDialog = page.getByRole("dialog", { name: /Game results|本局结算/ });
  await expect(settlementDialog).toBeVisible();
  await expect(settlementDialog.locator(".settlement-award")).toHaveCount(3);
  await expect(settlementDialog.locator(".settlement-source-block")).toHaveCount(0);
  await expect(settlementDialog.locator(".settlement-source-lane")).toHaveCount(0);
  await expect(settlementDialog.locator(".settlement-source-tag")).toHaveCount(0);
  await expect(settlementDialog.locator(".settlement-score-icon")).toHaveCount(1);
  await expect(settlementDialog.locator(".settlement-actor")).toHaveCount(2);
  await expect(settlementDialog.locator(".settlement-score-value")).toContainText("--/10");
  await page.waitForTimeout(900);
  const desktopDialogBox = await settlementDialog.boundingBox();
  const desktopMeterBox = await settlementDialog.locator(".settlement-score-meter").boundingBox();
  expect(desktopDialogBox).not.toBeNull();
  expect(desktopMeterBox).not.toBeNull();
  expect(desktopMeterBox!.y + desktopMeterBox!.height).toBeLessThanOrEqual(
    desktopDialogBox!.y + desktopDialogBox!.height
  );
  await settlementDialog.screenshot({ path: "work/qa/settlement-1440x900.png" });
  await settlementDialog.getByRole("button", { name: /Close results|关闭结算/ }).click();
  await expect(settlementDialog).toBeHidden();
  const firstDrawingPreview = page
    .locator(".turn-contribution-preview.is-inline .contribution-image-button")
    .first();
  await firstDrawingPreview.click();
  const drawingLightbox = page.locator(".drawing-lightbox");
  await expect(drawingLightbox).toBeVisible();
  expect(await paintedPixelsIn(drawingLightbox.locator("canvas"))).toBeGreaterThan(100);
  await drawingLightbox.screenshot({ path: "work/qa/contribution-lightbox-1440x900.png" });
  await drawingLightbox
    .getByRole("button", { name: /Close enlarged drawing|关闭放大画作/ })
    .click();
  await expect(drawingLightbox).toBeHidden();
  const firstReviewAvatar = page.locator(".review-avatar-anchor").first();
  await firstReviewAvatar.hover();
  await expect(firstReviewAvatar.locator(".avatar-contribution-popover")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export replay|导出回放/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("-v1.json");
  await page.screenshot({ path: "work/qa/reveal-1440x900.png", fullPage: true });
  await page.getByRole("button", { name: /Play again|再来一局/ }).click();
  await expect(page.locator(".lobby-screen")).toBeVisible();
  await expect(page.getByRole("button", { name: /Start relay|开始接龙/ })).toBeVisible();
});

test("roundtable resumes when a review packet is lost", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBufferLike>) {
        if (typeof data === "string") {
          try {
            const message = JSON.parse(data) as { type?: string };
            const debugWindow = window as typeof window & { __droppedReviewPacket?: boolean };
            if (message.type === "postgame.review" && debugWindow.__droppedReviewPacket !== true) {
              debugWindow.__droppedReviewPacket = true;
              return;
            }
          } catch {
            // Non-JSON WebSocket traffic is forwarded unchanged.
          }
        }
        (
          NativeWebSocket.prototype.send as (
            this: WebSocket,
            value: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBufferLike>
          ) => void
        ).call(this, data);
      }
    };
  });

  await createRoom(page, "Retry Host");
  await startRelay(page);
  await expect(page.locator(".reveal-screen")).toBeVisible({ timeout: 50_000 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __droppedReviewPacket?: boolean }).__droppedReviewPacket ===
          true
      )
    )
    .toBe(true);
  await expect(page.locator(".persona-review")).toHaveCount(8, { timeout: 15_000 });
  await expect(page.locator(".review-loading")).toHaveCount(0);
});

test("mobile after-game banter keeps reactions inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await createRoom(page, "Pocket Host");
  await startRelay(page);
  await expect(page.locator(".reveal-screen")).toBeVisible({ timeout: 50_000 });
  await expect(page.locator(".persona-review")).toHaveCount(8, { timeout: 15_000 });
  await expect(page.locator(".persona-review.is-departed")).toHaveCount(8);
  await expect(page.locator(".review-action")).toHaveCount(0);
  const roundtable = page.locator(".postgame-reviews");
  await expect(roundtable).toBeVisible();
  await expect(roundtable.getByRole("button", { name: /View results|查看结算/ })).toHaveCount(2);
  expect(await roundtable.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true
  );
  await roundtable.locator(".settlement-footer .settlement-trigger").click();
  const settlementDialog = page.getByRole("dialog", { name: /Game results|本局结算/ });
  await expect(settlementDialog).toBeVisible();
  expect(
    await settlementDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await page.waitForTimeout(900);
  const mobileDialogBox = await settlementDialog.boundingBox();
  const mobileMeterBox = await settlementDialog.locator(".settlement-score-meter").boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect(mobileMeterBox).not.toBeNull();
  expect(mobileMeterBox!.y + mobileMeterBox!.height).toBeLessThanOrEqual(
    mobileDialogBox!.y + mobileDialogBox!.height
  );
  await settlementDialog.screenshot({ path: "work/qa/settlement-390x844.png" });
  await settlementDialog.getByRole("button", { name: /Close results|关闭结算/ }).click();
  await roundtable.screenshot({ path: "work/qa/roundtable-390x844.png" });
});

test("blind relay roundtable keeps the human player beside AI seats", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  test.setTimeout(80_000);
  await createRoom(page, "Human Host", "blind");
  await openAdvancedOptions(page);
  const chainSetting = page.locator(".numeric-setting", { hasText: /Links|棒数/ });
  await chainSetting.locator('input[type="number"]').fill("4");
  await page.getByRole("button", { name: /Save rules|保存规则/ }).click();
  await startRelay(page);

  for (let cycle = 0; cycle < 180; cycle += 1) {
    if (
      await page
        .locator(".reveal-screen")
        .isVisible()
        .catch(() => false)
    )
      break;
    await actWhenNeeded(page);
    await page.waitForTimeout(250);
  }

  await expect(page.locator(".reveal-screen")).toBeVisible({ timeout: 20_000 });
  const humanPost = page.locator(".persona-review.roundtable-human");
  await expect(humanPost).toHaveCount(1);
  await expect(humanPost).toContainText("Human Host");
  await expect(humanPost.locator(".turn-contribution-preview.is-inline")).toBeVisible();
  await page.screenshot({ path: "work/qa/human-roundtable-1440x900.png", fullPage: true });
});

test("custom prompts keep language and type tags behind an observer spoiler lock", async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Prompt Keeper", "blind");
  await page.getByRole("button", { name: /Start relay|开始接龙/ }).click();
  const promptDialog = page.getByRole("dialog", {
    name: /Choose this game's prompt|选择本局题目/
  });
  await promptDialog.getByPlaceholder(/common word|常用词/).fill("守株待兔");
  await promptDialog.getByLabel(/Prompt language|题目语言/).selectOption("zh-CN");
  await promptDialog.getByLabel(/Prompt type|题目类型/).selectOption("idiom");
  await promptDialog.getByLabel(/Subject category|题材类型/).selectOption("history");
  await promptDialog.getByRole("button", { name: /Confirm prompt|确认题目/ }).click();

  await expect(page.locator(".timeline-slot", { hasText: "Prompt Keeper" })).toHaveCount(0);
  await expect(page.locator(".spoiler-log")).toHaveCount(0);
  await expect(page.getByText("守株待兔", { exact: true })).toHaveCount(0);
  const promptSpec = page.locator(".game-prompt-spec");
  await expect(promptSpec).toContainText(/Prompt format|题目规格/);
  await expect(promptSpec.locator(".prompt-tags")).toContainText(/4-character idiom|4字成语/);
  await expect(promptSpec.locator(".prompt-tags")).toContainText(/History|历史/);
  await expect(
    promptSpec.getByRole("button", { name: /Unlock spoilers|解除剧透锁/ })
  ).toBeVisible();
  await page.getByRole("button", { name: /Unlock spoilers|解除剧透锁/ }).click();
  await expect(promptSpec.locator(".game-prompt-current strong")).toHaveText("守株待兔");
  await page.screenshot({ path: "work/qa/spoiler-header-1440x900.png", fullPage: false });
  const spoilerLog = page.locator(".reaction-feed .spoiler-log");
  await expect(spoilerLog.locator(".spoiler-prompt strong")).toHaveText("守株待兔");
  await expect(spoilerLog.locator(".spoiler-prompt .prompt-tags")).toContainText(
    /4字成语|4-character idiom/
  );
  await expect(spoilerLog.locator("li").first()).toBeVisible({ timeout: 15_000 });
});

test("spectators keep seeing the drawing while the next AI reacts", async ({
  browser
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const spectatorContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  const spectator = await spectatorContext.newPage();
  const roomCode = await createRoom(host, "Host");
  await joinRoom(spectator, roomCode, "Watcher", "spectator");
  await startRelay(host);
  await expect(spectator.locator(".play-surface canvas")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => spectator.locator(".reaction-note").count(), { timeout: 20_000 }).toBe(2);
  expect(await paintedPixels(spectator)).toBeGreaterThan(100);
  await hostContext.close();
  await spectatorContext.close();
});

test("a blind relay player keeps the handed-off canvas after guessing", async ({
  browser
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const roomCode = await createRoom(host, "Host", "blind");
  await joinRoom(guest, roomCode, "Friend");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const guestSlot = host.locator(".timeline-slot", { hasText: "Friend" });
    if ((await guestSlot.locator(".role-guess").count()) > 0) break;
    await host.getByRole("button", { name: /Randomize order|随机排位/ }).click();
    await host.waitForTimeout(100);
  }
  await expect(
    host.locator(".timeline-slot", { hasText: "Friend" }).locator(".role-guess")
  ).toHaveCount(1);
  await startRelay(host);

  for (let cycle = 0; cycle < 80; cycle += 1) {
    await actWhenNeeded(host);
    if (
      await guest
        .getByPlaceholder(/What is this drawing|这幅画是什么/)
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await host.waitForTimeout(250);
  }
  const guess = guest.getByPlaceholder(/What is this drawing|这幅画是什么/);
  await expect(guess).toBeVisible({ timeout: 20_000 });
  expect(await paintedPixels(guest)).toBeGreaterThan(100);
  await guess.fill("a handed off drawing");
  await guest.getByRole("button", { name: /Submit guess|提交猜测/ }).click();
  await expect(guest.locator(".reaction-note")).not.toHaveCount(0);
  expect(await paintedPixels(guest)).toBeGreaterThan(100);
  await hostContext.close();
  await guestContext.close();
});

test("a spectator receives live stroke previews", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const spectatorContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  const spectator = await spectatorContext.newPage();
  const roomCode = await createRoom(host, "Artist", "blind");
  await joinRoom(spectator, roomCode, "Watcher", "spectator");
  await randomizeActorIntoFirstSlot(host, "Artist");
  await startRelay(host);
  const canvas = host.locator("canvas.is-editable");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await host.mouse.move(box!.x + 60, box!.y + 60);
  await host.mouse.down();
  await host.mouse.move(box!.x + box!.width - 60, box!.y + box!.height - 60, { steps: 12 });
  await host.mouse.up();
  await expect.poll(() => paintedPixels(spectator), { timeout: 8_000 }).toBeGreaterThan(100);
  await hostContext.close();
  await spectatorContext.close();
});

test("mobile drawing keeps a stable 4:3 canvas and usable toolbar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await createRoom(page, "Mobile Artist", "blind");
  await randomizeActorIntoFirstSlot(page, "Mobile Artist");
  await startRelay(page);
  const canvas = page.locator("canvas.is-editable");
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width / box!.height - 4 / 3)).toBeLessThan(0.02);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 30);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 40, { steps: 4 });
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height - 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.mouse.move(box!.x + 35, box!.y + box!.height - 40);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 45, { steps: 10 });
  await page.mouse.move(box!.x + box!.width - 35, box!.y + box!.height - 40, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".canvas-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: /Finish|完成/ })).toBeVisible();
  const toolbarBox = await page.locator(".canvas-toolbar").boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: "work/qa/drawing-390x844.png" });
});

test("blind relay hides content, negotiates preview transport, and accepts both humans", async ({
  browser
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "desktop-firefox", "desktop-webkit"].includes(testInfo.project.name)
  );
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const roomCode = await createRoom(host, "Host", "blind");
  await joinRoom(guest, roomCode, "Friend");
  await expect(host.locator(".participant-list").getByText("Friend")).toBeVisible();
  await expect(host.locator(".connection-pill")).toContainText(/WebRTC|WebSocket/, {
    timeout: 15_000
  });
  await startRelay(host);

  await expect
    .poll(
      async () =>
        (await host.locator(".blind-wait-state").count()) +
        (await guest.locator(".blind-wait-state").count()),
      { timeout: 12_000 }
    )
    .toBeGreaterThan(0);
  const waiting = (await host.locator(".blind-wait-state").count()) > 0 ? host : guest;
  await expect(waiting.locator(".input-clue")).toHaveCount(0);

  for (let cycle = 0; cycle < 100; cycle += 1) {
    await actWhenNeeded(host);
    await actWhenNeeded(guest);
    if (
      (await host.locator(".reveal-screen").count()) > 0 &&
      (await guest.locator(".reveal-screen").count()) > 0
    )
      break;
    await host.waitForTimeout(350);
  }
  await expect(host.locator(".reveal-screen")).toBeVisible({ timeout: 20_000 });
  await expect(guest.locator(".reveal-screen")).toBeVisible({ timeout: 20_000 });
  await hostContext.close();
  await guestContext.close();
});

test("a player can fill an enclosed region with the paint bucket", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Painter", "blind");
  await randomizeActorIntoFirstSlot(page, "Painter");
  await startRelay(page);
  const canvas = page.locator("canvas.is-editable");
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const left = box!.x + box!.width * 0.25;
  const right = box!.x + box!.width * 0.75;
  const top = box!.y + box!.height * 0.25;
  const bottom = box!.y + box!.height * 0.75;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, top, { steps: 8 });
  await page.mouse.move(right, bottom, { steps: 8 });
  await page.mouse.move(left, bottom, { steps: 8 });
  await page.mouse.move(left, top, { steps: 8 });
  await page.mouse.up();
  const outlinedPixels = await paintedPixelsIn(canvas);

  await page.getByRole("button", { name: /Fill|填充/ }).click();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(() => paintedPixelsIn(canvas)).toBeGreaterThan(outlinedPixels * 4);
});

test("a human drawing timeout submits the last saved canvas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await createRoom(page, "Slow Painter", "blind");
  await randomizeActorIntoFirstSlot(page, "Slow Painter");
  await openAdvancedOptions(page);
  const drawingTime = page.locator(".numeric-setting", {
    hasText: /Drawing time|作画时间/
  });
  await drawingTime.locator('input[type="number"]').fill("30");
  await startRelay(page);
  const canvas = page.locator("canvas.is-editable");
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 80, box!.y + box!.height - 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 80, { steps: 12 });
  await page.mouse.move(box!.x + box!.width - 80, box!.y + box!.height - 80, { steps: 12 });
  await page.mouse.up();
  expect(await paintedPixelsIn(canvas)).toBeGreaterThan(100);

  await expect(page.locator(".reaction-note")).not.toHaveCount(0, { timeout: 35_000 });
  expect(await paintedPixels(page)).toBeGreaterThan(100);
  await expect(page.locator(".model-fault-screen")).toHaveCount(0);
});

test("WebRTC failure falls back and a disconnected host transfers ownership", async ({
  browser
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await hostContext.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  await guestContext.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const roomCode = await createRoom(host, "First Host");
  await joinRoom(guest, roomCode, "Next Host");
  await expect(guest.getByText(/WebSocket/)).toBeVisible();
  await hostContext.close();
  await expect(guest.getByRole("button", { name: /Start relay|开始接龙/ })).toBeVisible({
    timeout: 10_000
  });
  await guestContext.close();
});

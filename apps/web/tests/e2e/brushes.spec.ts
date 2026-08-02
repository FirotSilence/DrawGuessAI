import { expect, test } from "@playwright/test";

test("brush presets stay continuous and render distinct textures", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await page.goto("/");

  const metrics = await page.evaluate(async () => {
    const modulePath = "/src/lib/canvas-renderer.ts";
    const { drawStroke } = (await import(modulePath)) as {
      drawStroke: (
        context: CanvasRenderingContext2D,
        stroke: {
          type: "stroke";
          id: string;
          tool: "pen";
          brushPreset: "ink" | "pencil" | "marker" | "paint";
          color: string;
          width: 28;
          points: { x: number; y: number }[];
          offsetMs: 0;
        }
      ) => void;
    };
    const presets = ["ink", "pencil", "marker", "paint"] as const;
    document.body.replaceChildren();
    Object.assign(document.body.style, {
      margin: "0",
      padding: "32px",
      background: "#eef1ef",
      color: "#202124",
      fontFamily: "system-ui, sans-serif"
    });
    const heading = document.createElement("h1");
    heading.textContent = "Brush render QA";
    heading.style.margin = "0 0 20px";
    document.body.append(heading);

    return presets.map((brushPreset) => {
      const row = document.createElement("section");
      row.style.marginBottom = "18px";
      const label = document.createElement("strong");
      label.textContent = brushPreset;
      label.style.display = "block";
      label.style.marginBottom = "6px";
      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 160;
      Object.assign(canvas.style, {
        display: "block",
        width: "1000px",
        height: "160px",
        border: "1px solid #c8cfca",
        background: "#f7f8fa"
      });
      row.append(label, canvas);
      document.body.append(row);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#f7f8fa";
      context.fillRect(0, 0, canvas.width, canvas.height);
      drawStroke(context, {
        type: "stroke",
        id: "brush-gallery-stroke",
        tool: "pen",
        brushPreset,
        color: "#3f7edb",
        width: 28,
        points: [
          { x: 80, y: 95 },
          { x: 280, y: 55 },
          { x: 500, y: 105 },
          { x: 720, y: 45 },
          { x: 920, y: 85 }
        ],
        offsetMs: 0
      });

      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0x811c9dc5;
      for (let index = 0; index < pixels.length; index += 4) {
        hash ^= pixels[index]!;
        hash = Math.imul(hash, 0x01000193);
        hash ^= pixels[index + 1]!;
        hash = Math.imul(hash, 0x01000193);
        hash ^= pixels[index + 2]!;
        hash = Math.imul(hash, 0x01000193);
      }
      let coveredColumns = 0;
      for (let x = 80; x <= 920; x += 1) {
        let covered = false;
        for (let y = 20; y < 140; y += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset] !== 247 || pixels[offset + 1] !== 248 || pixels[offset + 2] !== 250) {
            covered = true;
            break;
          }
        }
        if (covered) coveredColumns += 1;
      }
      return { brushPreset, coveredColumns, hash: hash >>> 0 };
    });
  });

  expect(new Set(metrics.map(({ hash }) => hash)).size).toBe(4);
  for (const metric of metrics) expect(metric.coveredColumns).toBe(841);
  await page.screenshot({ path: "work/qa/brush-presets.png", fullPage: true });
});

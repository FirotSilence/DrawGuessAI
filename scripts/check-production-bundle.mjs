import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const distDirectory = path.resolve("apps/web/dist");
const forbiddenMarkers = [
  "Programmatic Demo Sketcher",
  "built-in-demo",
  "Local demo",
  "local-demo",
  "本地试玩"
];
const scannedExtensions = new Set([".css", ".html", ".js", ".map"]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
    })
  );
  return files.flat();
}

const violations = [];
for (const filePath of await filesUnder(distDirectory)) {
  if (!scannedExtensions.has(path.extname(filePath))) continue;
  const contents = await readFile(filePath, "utf8");
  for (const marker of forbiddenMarkers) {
    if (contents.includes(marker)) {
      violations.push(`${path.relative(process.cwd(), filePath)}: ${JSON.stringify(marker)}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Production bundle contains local-demo markers:\n${violations.join("\n")}`);
}

console.log("Production bundle contains no local-demo route or profile markers.");

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const prodVarsPath = resolve(process.cwd(), ".prod.vars");
const hasProdVars = existsSync(prodVarsPath);
const port = process.env.DRAWGUESSAI_WORKER_PORT?.trim() || "8787";
const wranglerArgs = ["exec", "wrangler", "dev", "--port", port];

if (hasProdVars) wranglerArgs.push("--env-file", prodVarsPath);

const packageManagerCli = process.env.npm_execpath;
if (packageManagerCli === undefined || packageManagerCli === "") {
  throw new Error("Run the Worker dev server through pnpm so Wrangler can be resolved locally.");
}

console.log(
  hasProdVars
    ? "[worker] Loading ignored .prod.vars for local server AI."
    : "[worker] No .prod.vars found; starting without deployment-owned AI profiles."
);

const child = spawn(process.execPath, [packageManagerCli, ...wranglerArgs], {
  stdio: "inherit",
  env: process.env
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`[worker] Failed to start Wrangler: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

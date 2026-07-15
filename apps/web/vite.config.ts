import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const deepSeekApiKey =
    process.env.DEEPSEEK_API_KEY?.trim() || environment.DEEPSEEK_API_KEY?.trim();
  const localDeepSeek =
    command === "serve" && deepSeekApiKey !== undefined && deepSeekApiKey !== ""
      ? {
          apiKey: deepSeekApiKey,
          baseUrl:
            process.env.DEEPSEEK_BASE_URL?.trim() ||
            environment.DEEPSEEK_BASE_URL?.trim() ||
            "https://api.deepseek.com/anthropic",
          model:
            process.env.DEEPSEEK_MODEL?.trim() ||
            environment.DEEPSEEK_MODEL?.trim() ||
            "DeepSeek-V4-Flash"
        }
      : null;
  const workerOrigin =
    process.env.DRAWGUESSAI_WORKER_ORIGIN?.trim() ||
    environment.DRAWGUESSAI_WORKER_ORIGIN?.trim() ||
    "http://127.0.0.1:8787";

  return {
    plugins: [react()],
    define: {
      __DRAWGUESSAI_LOCAL_DEEPSEEK__: JSON.stringify(localDeepSeek)
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target: workerOrigin,
          changeOrigin: true,
          ws: true
        },
        "/ccswitch": {
          target: "http://127.0.0.1:5000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ccswitch/, "")
        }
      }
    },
    build: {
      sourcemap: true,
      target: "es2022"
    }
  };
});

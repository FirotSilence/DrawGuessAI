import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __DRAWGUESSAI_PROGRAMMATIC_DEMO_PROFILE__: JSON.stringify({
      id: "demo",
      label: "Programmatic Demo Sketcher",
      protocol: "demo",
      execution: "local",
      baseUrl: "https://demo.invalid",
      model: "built-in-demo",
      capabilities: {
        vision: true,
        structuredOutput: "json-schema",
        observationMode: "one-shot",
        maxObservationPasses: 0,
        drawingPlanMode: "inline"
      },
      enabled: true
    })
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/web/tests/**/*.test.ts?(x)"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts", "apps/worker/src/**/*.ts"]
    }
  }
});

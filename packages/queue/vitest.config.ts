import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom gives the browser-side client/admin/React tests a WebSocket,
    // localStorage, and crypto without a real network or DOM bootstrap. The
    // server/config/coordinator suites only need a stubbable global fetch,
    // which works the same under jsdom.
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Barrel files and type-only modules have no behavior to exercise.
      exclude: ["src/index.ts", "src/server/index.ts"],
      reporter: ["text", "html"],
    },
  },
});

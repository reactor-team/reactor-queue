import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/react.tsx",
    "src/admin-client.ts",
    "src/admin-react.tsx",
    "src/server/index.ts",
    "src/protocol.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [
    "react",
    "react/jsx-runtime",
    "zustand",
    "zustand/vanilla",
    "partykit",
    "partykit/server",
  ],
});

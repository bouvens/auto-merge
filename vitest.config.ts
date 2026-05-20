import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // globals=false: avoids polluting the global scope; import test helpers explicitly per file.
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});

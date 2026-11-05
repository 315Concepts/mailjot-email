import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Measure the code that ships: the engine, the transports and the templates.
      include: ["engine/**/*.{ts,tsx}", "transports/**/*.{ts,tsx}", "templates/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.stories.tsx", // Storybook-only
        "**/*.d.ts",
        // The process entry point. Its test (engine/index.test.ts) starts it as a child process, which
        // in-process coverage cannot see, so it would always read 0% whatever the tests check.
        "engine/index.ts",
      ],
      // Terminal table, a browsable report in coverage/index.html, and a machine-readable summary.
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});

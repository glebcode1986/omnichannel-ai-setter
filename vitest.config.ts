import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*",
      "packages/*",
      {
        test: {
          name: "tooling",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
    passWithNoTests: true,
  },
});

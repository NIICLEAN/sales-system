import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.spec.ts", "app/**/*.spec.tsx"],
    exclude: [".react-router/**", "build/**", "node_modules/**"],
  },
});

import { defineConfig } from "vitest/config";

// Pack-local vitest config so `npm test` runs standalone inside the split repo
// (where this dir is the repo root). The origin monorepo also picks these tests
// up via its own root include glob (packages/*/__tests__), so the pack-internal
// hygiene gate runs in BOTH the host repo CI and the split repo's shipped CI.
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});

import { defineConfig } from "vitest/config";

// Real PayPal sandbox contract tests. Need PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.
export default defineConfig({
  test: { include: ["apps/*/test/**/*.sandbox.test.ts"], testTimeout: 120_000, fileParallelism: false },
});

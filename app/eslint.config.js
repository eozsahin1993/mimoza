// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // `jest.mock` sits above the imports it replaces, which reads in the
    // order it takes effect — babel hoists the call either way.
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: { "import/first": "off" },
  },
]);

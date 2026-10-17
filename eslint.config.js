import js from "@eslint/js";
import globals from "globals";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/.dev-data/**",
      "**/.shots/**",
      "**/target/**",
      "**/gen/**",
      "apps/api/src/embedded.generated.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, Bun: "readonly" } },
    rules: {
      // Better Auth y Hono tipan de forma muy estricta algunos puntos: se permite `any` explícito con criterio
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parser: svelteParser, parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
  },
  {
    // Las rutas de la app son SPA con navegación interna sin `resolve()` (no hay base path)
    files: ["apps/web/**/*.svelte"],
    rules: { "svelte/no-navigation-without-resolve": "off", "svelte/require-each-key": "off" },
  },
);

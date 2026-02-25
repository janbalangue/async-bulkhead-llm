import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["dist", "node_modules", "coverage"],
  },

  // JS/MJS/CJS (no TS project)
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // TS only (type-aware)
  {
    files: ["**/*.{ts,tsx,cts,mts}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
    },
  },
  {
    files: ["test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      // Tests often inspect thrown errors & ad-hoc shapes.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",

      // Tests often use async callbacks for APIs even if no await.
      "@typescript-eslint/require-await": "off",

      // Allow intentionally-unused vars in tests, but keep "_" convention
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);

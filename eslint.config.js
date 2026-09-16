// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Package dependency direction and forbidden imports are enforced by `pnpm lint:boundaries`
 * (scripts/architecture), which runs as part of `pnpm lint`.
 */
export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/.next/",
    "**/out/",
    "**/coverage/",
    "**/next-env.d.ts",
  ]),

  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Discriminated unions (events, send outcomes, modes) must be handled exhaustively.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
    },
  },

  {
    // Only JavaScript *config* files skip type-aware linting. Any other JavaScript is not part of a
    // tsconfig project, so the project service rejects it and `pnpm lint` fails closed.
    files: ["*.config.{js,mjs,cjs}", "{apps,packages}/*/*.config.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Pure packages must not reach for Node.js process/runtime globals (see scripts/architecture/rules.ts).
    files: ["packages/{domain,channel-core,application}/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["process", "Buffer", "global", "require", "module", "__dirname", "__filename", "setImmediate"].map(
          (name) => ({ name, message: `${name} is a Node.js runtime global; pure packages must stay runtime-agnostic.` }),
        ),
      ],
    },
  },

  {
    // Repository tooling prints human-readable CLI output.
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"], reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      next: { rootDir: "apps/web" },
    },
  },
);

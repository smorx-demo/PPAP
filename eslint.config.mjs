import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "app/generated/**",
      // Vendored from smorx-demo/Autoballooning-with-versions (kept close to
      // upstream so it can be re-synced); type-checked, but not held to our lint rules.
      "components/autoballoon/**",
      "autoballoon-service/**",
    ],
  },
];

export default eslintConfig;

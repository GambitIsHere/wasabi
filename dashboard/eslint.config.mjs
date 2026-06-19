// Next.js 16 ships eslint-config-next as a native flat-config array, so we can
// spread it directly — no FlatCompat shim needed.
import next from "eslint-config-next";

const eslintConfig = [
  ...next,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default eslintConfig;

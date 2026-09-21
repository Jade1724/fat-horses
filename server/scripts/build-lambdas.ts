// Bundle each Lambda handler into dist/lambda/<name>/index.mjs for the Node.js 22 runtime.
// The AWS SDK v3 is included in the runtime, so it is left out of the bundle.

import { build } from "esbuild";

for (const name of ["api", "workflow"]) {
  await build({
    entryPoints: [`src/lambda/${name}.ts`],
    outfile: `dist/lambda/${name}/index.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    minify: true,
    external: ["@aws-sdk/*"],
    // ESM bundles need a require() for any CommonJS dependency.
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
  console.log(`built dist/lambda/${name}/index.mjs`);
}

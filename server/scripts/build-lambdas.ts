// Bundle each Lambda handler into dist/lambda/<name>/index.mjs for the Node.js 22 runtime.
// The runtime includes the AWS SDK v3, so the clients our code uses directly are
// left out of the bundle. The Bedrock SDK's own AWS dependencies are bundled: it
// expects a newer SDK than the runtime's fixed one, and AWS advises shipping the
// modules you depend on.

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
    external: [
      "@aws-sdk/client-dynamodb",
      "@aws-sdk/lib-dynamodb",
      "@aws-sdk/client-sfn",
      "@aws-sdk/client-ssm",
    ],
    // ESM bundles need a require() for any CommonJS dependency.
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
  console.log(`built dist/lambda/${name}/index.mjs`);
}

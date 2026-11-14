import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/main.js",
  // Bundled CommonJS deps (js-yaml) need `require` inside an ES module.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
chmodSync("dist/main.js", 0o755);

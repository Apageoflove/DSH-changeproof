// Build script: bundles Host CLI + client entry into dist/ via esbuild.
// DSH loads dist/host (service + tools) and dist/client (Web profile).
import { build } from "esbuild";
import { rm, mkdir, cp } from "node:fs/promises";
import path from "node:path";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/host/cli.ts", "src/host/index.ts", "src/host/adapters/dsh/cordis-plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: "dist/host",
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  external: ["react", "react-dom", "yaml"],
  sourcemap: true,
  logLevel: "info"
});

await build({
  entryPoints: ["src/client/index.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: "dist/client/index.mjs",
  external: ["react", "react-dom"],
  sourcemap: true,
  logLevel: "info"
});

// CSS modules are compiled inline by esbuild; also ship the raw tokens for theming docs.
await cp("src/client/styles", path.join("dist", "client", "styles"), { recursive: true }).catch(() => {});
console.log("build done");

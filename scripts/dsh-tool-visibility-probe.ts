// @ts-nocheck -- development probe: imports upstream DSH sources via file:// URLs (excluded from typecheck gate)
/**
 * External probe: boots the headless-equivalent DSH tree
 * (dsh-base + dsh-headless + dsh-changeproof patches, resolved from the DSH
 * source checkout exactly like the source-mode CLI does) WITHOUT running a
 * task, assembles the system prompt and prints exactly which tools the MODEL
 * would see this turn. Lives in the plugin repo; touches nothing upstream.
 */
import { boot } from "file:///E:/agent/DSH/packages/boot/app-boot/src/index.ts";
import { readFile } from "node:fs/promises";
import * as yaml from "file:///E:/agent/DSH/node_modules/js-yaml/index.js";
import { isJsExpr } from "file:///E:/agent/DSH/vendor/loader/src/config/utils.ts";

const patches = [];
for (const patchPath of [
  "E:/agent/DSH/packages/bundle/base/cordis.patch.yml",
  "E:/agent/dsh-changeproof/cordis.patch.yml"
]) {

  const text = await readFile(patchPath, "utf8");
  const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    resolve: (data: unknown) => typeof data === "string",
    construct: (data: unknown) => ({ __jsExpr: data }),
    predicate: isJsExpr,
    represent: (data: { __jsExpr: string }) => data["__jsExpr"]
  });
  const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA.extend(JsExpr) });
  if (Array.isArray(parsed)) patches.push(...parsed);
}

const ctx = await boot("dsh-probe", "C:/Users/Devin/.dsh/profiles/headless/cordis.yml", patches);
console.error("[probe] tree booted");


// same-moment anatomy

const assembly = await ctx.systemPrompt.assemble({});
const names = assembly.tools.map((t) => t.name);
console.log("MODEL-VISIBLE TOOLS (" + names.length + "):", JSON.stringify(names, null, 1));
console.log("changeproof visible:", names.filter((n) => n.startsWith("changeproof_")));
process.exit(0);

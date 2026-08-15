// Push the plugin tree to GitHub via the Git Data API (works when the git
// protocol is blocked but api.github.com is reachable).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ex = promisify(execFile);
const TOKEN = process.env.GH_TOKEN;
const OWNER = "Apageoflove";
const REPO = "DSH-changeproof";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

if (!TOKEN) { console.error("GH_TOKEN required"); process.exit(1); }

async function gh(method, url, body) {
  const args = [
    "-s", "-X", method,
    "-H", `Authorization: token ${TOKEN}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "Content-Type: application/json"
  ];
  if (body) {
    // --data-binary @file avoids the Windows command-line length limit
    const tmp = path.join(process.cwd(), ".tmp", "gh-body.json");
    await import("node:fs/promises").then((m) => m.writeFile(tmp, body, "utf8"));
    args.push("--data-binary", `@${tmp}`);
  }
  const { stdout } = await ex("curl", [...args, url], { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (parsed.message && !parsed.sha) throw new Error(`${method} ${url}: ${parsed.message}`);
  return parsed;
}

async function getDefaultSha() {
  try {
    const { stdout } = await ex("curl", [
      "-s", "-H", `Authorization: token ${TOKEN}`,
      "-H", "Accept: application/vnd.github+json",
      `${API}/git/refs/heads/main`
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return parsed.object?.sha ?? null;
  } catch { return null; }
}

const { stdout: filesOut } = await ex("git", ["ls-files"], { cwd: process.cwd() });
const files = filesOut.split("\n").filter(Boolean).sort();
console.log(`files: ${files.length}`);

// 0) empty-repo bootstrap: GitHub's Git Data API refuses blobs on a repo with
//    zero commits; seed one via the Contents API first.
let parentSha = await getDefaultSha();
if (!parentSha) {
  const seed = await gh("PUT", `${API}/contents/README.md`, JSON.stringify({
    message: "chore: bootstrap empty repository",
    content: Buffer.from("# dsh-changeproof\n\nChangeProof - change-relevance + evidence-freshness quality plugin for DeepSeek Harness.\n").toString("base64")
  }));
  parentSha = seed.commit.sha;
  console.log("seeded initial commit", parentSha);
}

// 1) blobs (base64), small files only
const blobs = [];
for (const f of files) {
  const abs = path.join(process.cwd(), ...f.split("/"));
  const content = await readFile(abs);
  if (content.length > 500 * 1024) throw new Error(`file too large for API push: ${f}`);
  const blob = await gh("POST", `${API}/git/blobs`, JSON.stringify({
    content: content.toString("base64"),
    encoding: "base64"
  }));
  blobs.push({ path: f, mode: "100644", type: "blob", sha: blob.sha });
}

// 2) tree
const tree = await gh("POST", `${API}/git/trees`, JSON.stringify({ tree: blobs }));

// 3) commit
const commit = await gh("POST", `${API}/git/commits`, JSON.stringify({
  message: "ChangeProof: change-relevance + evidence-freshness plugin for DeepSeek Harness\n\n- changeproof_plan / changeproof_verify / changeproof_status\n- 6-state verdict machine\n- 4-tier impact resolution\n- Changed-line coverage (Istanbul + coverage.py)\n- Fingerprint freshness (stale detection)\n- Real DSH integration (deepseek-harness 47f9438)\n- 163 tests / 31 benchmark cases / 0 silent false-greens",
  tree: tree.sha,
  parents: [parentSha],
  author: { name: "Apageoflove", email: "apageoflove@users.noreply.github.com" },
  committer: { name: "Apageoflove", email: "apageoflove@users.noreply.github.com" }
}));

// 4) ref
await gh("PATCH", `${API}/git/refs/heads/main`, JSON.stringify({ sha: commit.sha, force: true }));
console.log("PUSHED commit", commit.sha, "- files:", files.length);

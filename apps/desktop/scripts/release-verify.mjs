import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const parserResourceRoot = path.join(appRoot, "src-tauri", "resources", "workers", "parser");
const migrationsResourceRoot = path.join(appRoot, "src-tauri", "resources", "migrations");
const promptsResourceRoot = path.join(appRoot, "src-tauri", "resources", "prompt-templates");
const bundleRoot = path.join(appRoot, "src-tauri", "target", "release", "bundle");

await mustExist(path.join(parserResourceRoot, "main.py"));
await mustExist(path.join(parserResourceRoot, "requirements.txt"));
await mustExist(path.join(migrationsResourceRoot, "0001_core.sql"));
await mustExist(path.join(promptsResourceRoot, "agent_planner_system.md"));

const parserFiles = await walkFiles(parserResourceRoot);
const parserInvalid = parserFiles.filter((filePath) =>
  /__pycache__|\.pyc$|\\tests\\|\/tests\//i.test(filePath)
);
if (parserInvalid.length > 0) {
  throw new Error(`parser 资源目录存在无效文件:\n${parserInvalid.join("\n")}`);
}

const migrationFiles = await walkFiles(migrationsResourceRoot);
if (migrationFiles.length === 0 || migrationFiles.some((filePath) => !filePath.endsWith(".sql"))) {
  throw new Error("migrations 资源目录不完整");
}

const promptFiles = await walkFiles(promptsResourceRoot);
if (promptFiles.length === 0 || promptFiles.some((filePath) => !filePath.endsWith(".md"))) {
  throw new Error("prompt-templates 资源目录不完整");
}

await mustExist(bundleRoot);
const bundleFiles = await walkFiles(bundleRoot);
const blockedPatterns = [
  /\.knowledgeos[\\/]/i,
  /[\\/]fixtures[\\/]/i,
  /test_worker\.py$/i,
  /__pycache__/i,
  /\.pytest_cache/i,
  /[\\\/]\.research[\\\/]/i
];
const blockedMatches = bundleFiles.filter((filePath) =>
  blockedPatterns.some((pattern) => pattern.test(filePath))
);
if (blockedMatches.length > 0) {
  throw new Error(`安装包内检测到测试或历史数据痕迹:\n${blockedMatches.join("\n")}`);
}

console.log("发布产物校验通过：未检测到测试数据污染。");

async function mustExist(targetPath) {
  await access(targetPath);
}

async function walkFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(appRoot, "..", "..");
const parserSourceRoot = path.join(workspaceRoot, "workers", "parser");
const parserResourceRoot = path.join(appRoot, "src-tauri", "resources", "workers", "parser");
const migrationsSourceRoot = path.join(appRoot, "src-tauri", "migrations");
const migrationsResourceRoot = path.join(appRoot, "src-tauri", "resources", "migrations");
const promptsSourceRoot = path.join(workspaceRoot, "packages", "prompt-templates");
const promptsResourceRoot = path.join(appRoot, "src-tauri", "resources", "prompt-templates");

await rm(parserResourceRoot, { recursive: true, force: true });
await mkdir(path.join(parserResourceRoot, "parsers"), { recursive: true });
await rm(migrationsResourceRoot, { recursive: true, force: true });
await mkdir(migrationsResourceRoot, { recursive: true });
await rm(promptsResourceRoot, { recursive: true, force: true });
await mkdir(promptsResourceRoot, { recursive: true });

await cp(path.join(parserSourceRoot, "main.py"), path.join(parserResourceRoot, "main.py"));
await cp(
  path.join(parserSourceRoot, "requirements.txt"),
  path.join(parserResourceRoot, "requirements.txt")
);

await copyParserModules(
  path.join(parserSourceRoot, "parsers"),
  path.join(parserResourceRoot, "parsers")
);
await copyFilesByExtension(migrationsSourceRoot, migrationsResourceRoot, ".sql");
await copyFilesByExtension(promptsSourceRoot, promptsResourceRoot, ".md");

console.log("发布资源准备完成：parser、migrations、prompt-templates 已同步到 src-tauri/resources。");

async function copyParserModules(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__pycache__") {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyParserModules(sourcePath, targetPath);
      continue;
    }
    if (!entry.name.endsWith(".py")) {
      continue;
    }
    await cp(sourcePath, targetPath);
  }
}

async function copyFilesByExtension(sourceDir, targetDir, extension) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(extension)) {
      continue;
    }
    await cp(sourcePath, path.join(targetDir, entry.name));
  }
}

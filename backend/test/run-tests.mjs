import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(candidate) : [candidate];
  }));
  return files.flat().filter((file) => file.endsWith(".test.ts")).sort();
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "rightrent-tests-"));
const files = await testFiles(path.resolve("test"));
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DRIVER: "memory",
    MONGODB_URI: "",
    ANALYSIS_PROVIDER: "deterministic",
    PII_NER_MODE: "regex",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    INTERNAL_API_TOKEN: "",
    JWT_SECRET: "test-only-rightrent-secret-never-production",
    CORS_ORIGINS: "http://localhost:5173",
    UPLOAD_DIR: path.join(temporaryRoot, "uploads"),
    MARKED_PDF_DIR: path.join(temporaryRoot, "marked-pdfs"),
  },
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
await rm(temporaryRoot, { recursive: true, force: true });
process.exitCode = exitCode;

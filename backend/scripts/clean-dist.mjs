import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (manifest.name !== "rightrent-backend") {
  throw new Error("Refusing to clean dist outside the RightRent backend package.");
}
const dist = path.join(projectRoot, "dist");
if (path.basename(dist) !== "dist" || path.dirname(dist) !== projectRoot) {
  throw new Error("Refusing to clean an unexpected build directory.");
}
await rm(dist, { recursive: true, force: true });

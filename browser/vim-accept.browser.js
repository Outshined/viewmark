import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Part files arrive from other checkouts. A missing directory is an empty suite.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "vim-accept");
if (existsSync(dir)) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) await import(pathToFileURL(path.join(dir, name)));
}

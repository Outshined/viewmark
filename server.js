import http from "node:http";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.dirname(fileURLToPath(import.meta.url)));

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

export function start(port) {
  const server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function handleRequest(req, res) {
  serveStatic(req, res).catch((err) => {
    console.error(err);
    if (res.writableEnded) return;
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  const filePath = localPath(req.url ?? "");
  if (!filePath) {
    res.writeHead(404);
    res.end();
    return;
  }

  let real;
  try {
    real = await fs.realpath(filePath);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  // A link whose lexical path is inside the root can still point outside it.
  if (!insideRoot(real) || !(await isFile(real))) {
    res.writeHead(404);
    res.end();
    return;
  }

  const body = await fs.readFile(real);
  const type = types[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function isFile(filePath) {
  try {
    const info = await fs.stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function localPath(url) {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  let end = url.length;
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  const raw = url.slice(0, end);
  if (!raw.startsWith("/")) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  if (decoded === "/") decoded = "/index.html";

  // "." keeps an absolute decoded path from discarding root. path.resolve
  // drops earlier segments when a later one is absolute.
  const resolved = path.resolve(root, `.${decoded}`);
  if (!insideRoot(resolved)) return null;
  return resolved;
}

function insideRoot(candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT ? Number(process.env.PORT) : 8765;
  start(port).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

import http from "node:http";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./src/hub.js";

const root = realpathSync(path.dirname(fileURLToPath(import.meta.url)));

const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

export async function start(port, stateDir) {
  let ownsTemp = false;
  let dir = stateDir ? path.resolve(stateDir) : "";
  if (!dir) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-state-"));
    ownsTemp = true;
  } else {
    await fs.mkdir(dir, { recursive: true });
  }
  dir = await fs.realpath(dir);
  const hub = await createHub(dir, root);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, hub).catch((err) => {
      console.error(err);
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  server.stateDir = dir;
  const closeServer = server.close.bind(server);
  let closing = null;
  server.close = (callback) => {
    if (!closing) {
      const pending = hub.shutdown();
      closing = new Promise((resolve) => {
        closeServer((err) => {
          pending.then(() => resolve(err ?? null), (shutdownErr) => resolve(shutdownErr ?? err ?? null));
        });
      });
    }
    closing.then((err) => callback?.(err));
    return server;
  };
  server.on("close", () => {
    if (ownsTemp) {
      hub.shutdown().finally(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

function pathnameOf(url) {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  let end = url.length;
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  return url.slice(0, end);
}

async function handleRequest(req, res, hub) {
  const pathname = pathnameOf(req.url ?? "");
  if (pathname === "/api/ws") {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname === "/raw" || pathname.startsWith("/raw/")) {
    const rest = pathname.startsWith("/raw/") ? pathname.slice("/raw/".length) : "";
    const slash = rest.indexOf("/");
    if (!rest || slash <= 0) {
      res.writeHead(404);
      res.end();
      return;
    }
    let name;
    try {
      name = decodeURIComponent(rest.slice(0, slash));
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const repoPath = hub.repoPath(name);
    if (!repoPath) {
      res.writeHead(404);
      res.end();
      return;
    }
    await serveStatic(req, res, repoPath, rest.slice(slash), false);
    return;
  }
  await serveStatic(req, res, root, req.url ?? "", true);
}

async function serveStatic(req, res, rootDir, url, index) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  const filePath = localPath(rootDir, url, index);
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
  if (!insideRoot(rootDir, real) || !(await isFile(real))) {
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

function localPath(rootDir, url, index) {
  const raw = pathnameOf(url);
  if (!raw.startsWith("/")) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  if (decoded === "/") {
    if (!index) return null;
    decoded = "/index.html";
  }

  // "." keeps an absolute decoded path from discarding root. path.resolve
  // drops earlier segments when a later one is absolute.
  const resolved = path.resolve(rootDir, `.${decoded}`);
  if (!insideRoot(rootDir, resolved)) return null;
  return resolved;
}

function insideRoot(rootDir, candidate) {
  const rel = path.relative(rootDir, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  const stateArg = process.argv[2];
  if (!stateArg) {
    console.error("usage: node server.js <state-dir>");
    process.exitCode = 1;
  } else {
    const port = process.env.PORT ? Number(process.env.PORT) : 8765;
    start(port, stateArg).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  }
}

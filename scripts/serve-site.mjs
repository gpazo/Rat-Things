import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, extname, sep } from "node:path";

const root = resolve("dist-pages");
const port = Number(
  process.argv.find((value) => value.startsWith("--port="))?.split("=")[1] ??
    4173,
);
const watchMode = process.argv.includes("--watch");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".txt": "text/plain",
};

createServer(async (request, response) => {
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    // Serve the real Pages prefix too, so browser tests catch root-relative URLs.
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    ).replace(/^\/Rat-Things(?=\/|$)/, "");
    let file = resolve(root, `.${pathname || "/"}`);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) {
      if (!request.url.split("?")[0].endsWith("/")) {
        response
          .writeHead(301, {
            Location: `${request.url.split("?")[0]}/${new URL(request.url, "http://localhost").search}`,
          })
          .end();
        return;
      }
      file = resolve(file, "index.html");
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": body.length,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Rat Things architecture: http://127.0.0.1:${port}`),
);

if (watchMode) {
  let timer;
  let building = false;
  let pending = false;
  function rebuild() {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    const build = spawn(process.execPath, ["scripts/build-pages.mjs"], {
      stdio: "inherit",
    });
    build.on("exit", () => {
      building = false;
      if (pending) {
        pending = false;
        rebuild();
      }
    });
  }
  for (const directory of [
    "site",
    "src",
    "infra/modules/agent-runner",
    "microvm",
  ]) {
    watch(directory, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 200);
    });
  }
}

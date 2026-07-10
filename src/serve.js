import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/**
 * Minimal static server over OUTPUT_DIR so the Instagram Graph API can fetch
 * rendered slides by URL. Put it behind a reverse proxy / tunnel and point
 * PUBLIC_MEDIA_BASE_URL at the public address.
 */
export function serveMedia() {
  const root = config.outputDir;
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.normalize(path.join(root, urlPath));
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
        "Content-Length": stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
  server.listen(config.mediaServerPort, () => {
    console.log(
      `[serve] media server on http://0.0.0.0:${config.mediaServerPort} serving ${root}`,
    );
  });
  return server;
}

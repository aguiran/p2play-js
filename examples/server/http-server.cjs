const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

const port = 8080;

// Serve from the project root (../../ from examples/server)
const baseDir = path.resolve(__dirname, '../../');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  try {
    const parsedUrl = url.parse(req.url);
    const decodedPathname = decodeURIComponent(parsedUrl.pathname || '/');
    let pathname = path.join(baseDir, decodedPathname);

    // Prevent path traversal
    const root = baseDir;
    const resolved = path.resolve(pathname);
    if (!resolved.startsWith(root)) {
      res.writeHead(400);
      return res.end('Bad request');
    }

    // Resolve extensionless ESM to .js or .mjs BEFORE stat
    let filePath = resolved;
    if (path.extname(filePath) === '') {
      const jsAlt = filePath + '.js';
      const mjsAlt = filePath + '.mjs';
      if (fs.existsSync(jsAlt)) filePath = jsAlt;
      else if (fs.existsSync(mjsAlt)) filePath = mjsAlt;
    }

    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      // If not found even after extension resolution, 404
      res.writeHead(404);
      return res.end('Not found');
    }

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        res.writeHead(404);
        return res.end('Not found');
      }
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = mime[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

server.listen(port, () => {
  console.log(`Static server (examples/dist) listening at http://localhost:${port}`);
  console.log(`Serving from: ${baseDir}`);
});



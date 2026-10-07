#!/usr/bin/env node
/**
 * Minimal static file server for the Playwright webServer (and local dev).
 *
 * http-server crashes on unhandled socket errors (EPIPE/ECONNRESET) when
 * browser workers abort requests under load, which fails every remaining
 * test with ERR_CONNECTION_REFUSED. This server never lets a socket error
 * escape: it logs and keeps serving. Zero dependencies.
 *
 * Usage: node scripts/dev-server.cjs [port] [root]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2] || process.env.PORT || 3070);
const root = path.resolve(process.argv[3] || process.cwd());

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
    '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filePath = path.normalize(path.join(root, urlPath));
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
        if (stat && stat.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
            stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
        }
        if (!stat || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
            try { res.destroy(); } catch { /* socket already gone */ }
        });
        stream.pipe(res);
    } catch (err) {
        try {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('server error');
        } catch { /* socket already gone */ }
    }
});

// A misbehaving client must never take the server down.
server.on('clientError', (err, socket) => {
    try {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        else socket.destroy();
    } catch { /* socket already gone */ }
});
process.on('uncaughtException', (err) => {
    console.error('[dev-server] recovered from:', err && err.message);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[dev-server] serving ${root} on http://localhost:${port}`);
});

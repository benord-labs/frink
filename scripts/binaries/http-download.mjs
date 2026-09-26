/**
 * Shared HTTPS download helpers for the bundled-binary build scripts
 * (download-claude-binary.mjs + build-codex-frink.mjs). One copy of the
 * redirect-following get / stream-to-file / sha256 logic so the two scripts
 * don't each carry their own.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

const UA = 'frink-build';

/** GET a URL (following 301/302), resolving a Buffer — or parsed JSON when `json` is set. */
export function fetchUrl(url, { headers = {}, json = false } = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchUrl(res.headers.location, { headers, json }).then(resolve, reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve(
            json ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : Buffer.concat(chunks),
          ),
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Stream a URL (following 301/302) to `destPath`; `onProgress(percent)` is called per chunk if given. */
export function downloadToFile(url, destPath, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const fail = (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    };
    const go = (u) => {
      https
        .get(u, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) return go(res.headers.location);
          if (res.statusCode !== 200) return fail(new Error(`HTTP ${res.statusCode} for ${u}`));
          const total = Number(res.headers['content-length']);
          let done = 0;
          res.on('data', (c) => {
            done += c.length;
            if (onProgress && total > 0) onProgress(Math.floor((done / total) * 100));
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          res.on('error', fail);
        })
        .on('error', fail);
    };
    go(url);
  });
}

/** SHA-256 hex digest of a file. */
export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

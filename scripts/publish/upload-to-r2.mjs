#!/usr/bin/env node
/**
 * Uploads Electron release artifacts to Cloudflare R2 (cdn.frink.dev).
 * Uses the S3-compatible API with multipart uploads (no file size limit).
 * Requires: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID in .env.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { assertPackagedAbi } from './assert-packaged-abi.mjs';

const RELEASE_DIR = 'release';
const BUCKET = process.env.R2_BUCKET ?? 'frink-releases';

const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = process.env;
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
  console.error(
    '[upload-to-r2] Missing R2 credentials. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID in .env',
  );
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// mac: .dmg/.zip; win: .exe (nsis+portable); linux: .AppImage/.deb. .yml = the per-OS auto-update
// manifest (latest.yml / latest-linux.yml / latest-mac.yml); .blockmap = mac delta-update map (nsis +
// AppImage embed theirs in the binary). Each OS's release/ holds only its own — per-OS legs upload
// their slice to the shared bucket, no collision.
const UPLOAD_EXTENSIONS = ['.dmg', '.zip', '.exe', '.AppImage', '.deb', '.yml', '.blockmap'];

// Every publishable manifest is `latest*.yml`. electron-builder also drops builder-debug.yml into
// release/ — a local diagnostic that nothing consumes, so it must not reach the public CDN.
const isUploadable = (f) =>
  f.endsWith('.yml') ? f.startsWith('latest') : UPLOAD_EXTENSIONS.some((ext) => f.endsWith(ext));

// Refuse to publish natives compiled for the wrong ABI/arch (the 0.0.10 boot-crash).
await assertPackagedAbi(RELEASE_DIR);

let files;
try {
  files = readdirSync(RELEASE_DIR).filter(isUploadable);
} catch {
  console.error(`[upload-to-r2] Could not read ${RELEASE_DIR}/ — did the build succeed?`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`[upload-to-r2] No release artifacts found in ${RELEASE_DIR}/`);
  process.exit(1);
}

console.log(`[upload-to-r2] Uploading ${files.length} file(s) to R2 bucket "${BUCKET}"...`);

const failures = [];

for (const file of files) {
  const localPath = join(RELEASE_DIR, file);
  try {
    const size = statSync(localPath).size;
    const sizeMiB = (size / (1024 * 1024)).toFixed(1);
    console.log(`  → ${file} (${sizeMiB} MiB)`);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: file,
        Body: createReadStream(localPath),
        ContentType: file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 100 * 1024 * 1024,
    });

    upload.on('httpUploadProgress', (progress) => {
      if (progress.loaded && progress.total) {
        const pct = ((progress.loaded / progress.total) * 100).toFixed(0);
        process.stdout.write(`\r    ${pct}%`);
      }
    });

    await upload.done();
    console.log('\r    done');
  } catch (err) {
    console.log('');
    console.error(`[upload-to-r2] Upload failed for "${file}" (${localPath}):`, err);
    failures.push({ file, localPath, error: err });
  }
}

if (failures.length > 0) {
  console.error(
    `[upload-to-r2] ${failures.length} of ${files.length} upload(s) failed; exiting with code 1.`,
  );
  process.exit(1);
}

console.log(
  '[upload-to-r2] Done. Files are live at https://pub-c942ee0fa0a549ef8d66096bd831507b.r2.dev/',
);

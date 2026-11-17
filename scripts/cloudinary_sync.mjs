#!/usr/bin/env node
// Mirrors the repo's .webp assets to Cloudinary, keeping every path as is,
// so consumers only swap their base URL:
//
//   https://raw.githubusercontent.com/gofinancials/gt_images/refs/heads/main/<path>
//   https://res.cloudinary.com/<cloud>/image/upload/<folder>/<path>
//
// Usage (Node 18+, no dependencies):
//   node scripts/cloudinary_sync.mjs                 upload every tracked .webp
//   node scripts/cloudinary_sync.mjs a.webp b.webp   upload only these files
//   node scripts/cloudinary_sync.mjs --verify [...]  check delivery URLs match local bytes
//   node scripts/cloudinary_sync.mjs --dry-run [...] print what would happen
//
// Reads CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and
// optional CLOUDINARY_FOLDER (default "gt_images") from the environment,
// falling back to a .env file in the repo root.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const verify = flags.has('--verify');
const dryRun = flags.has('--dry-run');
const CONCURRENCY = 8;

loadDotEnv(join(root, '.env'));
const cloud = requireEnv('CLOUDINARY_CLOUD_NAME');
const apiKey = verify ? null : requireEnv('CLOUDINARY_API_KEY');
const apiSecret = verify ? null : requireEnv('CLOUDINARY_API_SECRET');
const folder = (process.env.CLOUDINARY_FOLDER ?? 'gt_images').replace(/^\/+|\/+$/g, '');

const baseUrl = `https://res.cloudinary.com/${cloud}/image/upload${folder ? `/${folder}` : ''}`;

const files = selectFiles(args.filter((a) => !a.startsWith('--')));
console.log(`${verify ? 'Verifying' : 'Uploading'} ${files.length} file(s) → ${baseUrl}`);

const failures = [];
let done = 0;
await runPool(files, CONCURRENCY, async (path) => {
  try {
    if (dryRun) console.log(`  would ${verify ? 'check' : 'upload'} ${path}`);
    else if (verify) await check(path);
    else await upload(path);
  } catch (err) {
    failures.push(path);
    console.error(`  ✗ ${path}: ${err.message}`);
  }
  done++;
  if (!dryRun && done % 50 === 0) console.log(`  … ${done}/${files.length}`);
});

console.log(`${files.length - failures.length}/${files.length} ok`);
if (failures.length) process.exit(1);

// ---------------------------------------------------------------------------

function publicIdFor(path) {
  const noExt = path.replace(/\.[^./]+$/, '');
  return folder ? `${folder}/${noExt}` : noExt;
}

async function upload(path) {
  const publicId = publicIdFor(path);
  const assetFolder = posix.dirname(publicId) === '.' ? '' : posix.dirname(publicId);
  const params = {
    public_id: publicId,
    overwrite: 'true',
    invalidate: 'true',
    timestamp: String(Math.floor(Date.now() / 1000)),
    // Places the file in the matching Media Library folder on accounts that
    // use dynamic folders; fixed-folder accounts derive it from public_id.
    ...(assetFolder && { asset_folder: assetFolder }),
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append('api_key', apiKey);
  form.append('signature', createHash('sha1').update(toSign + apiSecret).digest('hex'));
  form.append('file', new Blob([readFileSync(join(root, path))], { type: 'image/webp' }), posix.basename(path));

  const res = await withRetry(() =>
    fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form }),
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body?.error?.message ?? ''}`.trim());
  const local = md5(readFileSync(join(root, path)));
  if (body.etag && body.etag !== local) throw new Error(`etag mismatch (${body.etag} ≠ ${local})`);
}

async function check(path) {
  const url = `${baseUrl}/${path}`;
  const res = await withRetry(() => fetch(url));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const type = res.headers.get('content-type');
  if (type !== 'image/webp') throw new Error(`content-type ${type}`);
  const remote = Buffer.from(await res.arrayBuffer());
  if (md5(remote) !== md5(readFileSync(join(root, path)))) throw new Error('bytes differ from git');
}

function selectFiles(explicit) {
  const list = explicit.length
    ? explicit
    : execFileSync('git', ['ls-files', '-z', '--', '*.webp'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
  return list
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p.endsWith('.webp') && existsSync(join(root, p)));
}

async function withRetry(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fn();
      if ((res.status === 429 || res.status >= 500) && i < attempts) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function runPool(items, size, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Set it in the environment or in .env.`);
    process.exit(2);
  }
  return value;
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

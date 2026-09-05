#!/usr/bin/env node
/**
 * release.mjs -- publish the current version to GitHub Releases.
 *
 * 1. Creates the release `v<version>` up front as a DRAFT (electron-builder
 *    races itself when two artifacts try to create the same release, and a
 *    published release with no assets yet makes every running app's update
 *    check fail until the upload finishes).
 * 2. Runs `electron-builder --win --publish always` (uploads the installer).
 * 3. Verifies the assets the updater needs (`latest.yml`, `<installer>.blockmap`)
 *    and uploads any that are missing, with the exact names electron-updater
 *    expects.
 * 4. Publishes the draft. Apps only ever see complete releases.
 *
 * Needs GH_TOKEN with permission to write releases. Run on Windows (NSIS).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { version } = pkg;
const publish = (pkg.build?.publish ?? [])[0];
if (!publish || publish.provider !== 'github') throw new Error('package.json build.publish must be a github provider');
const { owner, repo } = publish;
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN is not set');
const tag = `v${version}`;
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'ghetto-blocker-release' };

async function gh(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : api + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// 1. release exists?
async function findRelease() {
  const byTag = await gh(`/releases/tags/${tag}`);
  if (byTag) return byTag;
  // A draft is not reachable by tag until published; scan the list.
  const all = (await gh('/releases?per_page=30')) ?? [];
  return all.find((r) => r.tag_name === tag) ?? null;
}
let release = await findRelease();
if (!release) {
  console.log(`[release] creating ${tag}`);
  release = await gh('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, body: `ghetto-blocker ${version}`, draft: true, prerelease: false }),
  });
} else {
  console.log(`[release] ${tag} already exists (id ${release.id})`);
}

// 2. build + publish
const builder = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const build = spawnSync(process.execPath, [builder, '--win', '--x64', '--publish', 'always'], { cwd: root, stdio: 'inherit', env: process.env });
if (build.status !== 0) console.warn(`[release] electron-builder exited with ${build.status}; checking assets anyway`);

// 3. make sure the updater's files are there
const installer = `ghetto-blocker Setup ${version}.exe`;
const installerPath = join(root, 'release', installer);
if (!existsSync(installerPath)) throw new Error(`installer not found: ${installerPath}`);
const assetName = installer.replace(/ /g, '-');
const sha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
const size = statSync(installerPath).size;
const latestYml =
  `version: ${version}\nfiles:\n  - url: ${assetName}\n    sha512: ${sha512}\n    size: ${size}\n` +
  `path: ${assetName}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;

release = await findRelease();
const have = new Map(release.assets.map((a) => [a.name, a]));
async function upload(name, body, contentType) {
  const existing = have.get(name);
  if (existing) await gh(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  await gh(url, { method: 'POST', body, headers: { 'content-type': contentType, 'content-length': String(body.length) } });
  console.log(`[release] uploaded ${name}`);
}
if (!have.has(assetName)) await upload(assetName, readFileSync(installerPath), 'application/octet-stream');
await upload('latest.yml', Buffer.from(latestYml), 'text/yaml');
const blockmapPath = installerPath + '.blockmap';
if (existsSync(blockmapPath)) {
  for (const stray of release.assets) {
    if (stray.name.endsWith('.blockmap') && stray.name !== `${assetName}.blockmap`) await gh(`/releases/assets/${stray.id}`, { method: 'DELETE' });
  }
  await upload(`${assetName}.blockmap`, readFileSync(blockmapPath), 'application/octet-stream');
}
// 4. publish -- only now does the updater get to see it
let final = await gh(`/releases/${release.id}`);
if (final.draft) {
  final = await gh(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  console.log(`[release] published ${tag}`);
}
console.log(`[release] ${tag}: ${final.assets.map((a) => a.name).join(', ')}`);
console.log(`[release] ${final.html_url}`);

import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('./', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const upstream = read('upstream-1.2.1.plugin.js');
const upstreamSHA256 = '6d2378921eaf7bb234938b7204f707cc00f2a27dfad97c1ee58eb660d2808eb5';
if (sha(upstream) !== upstreamSHA256) throw new Error('MiniMax-Meta 1.2.1 source changed; review required');

const baseNormalizer = `function metasoAPIBase(baseUrl) {
  const base = trimmed(baseUrl).replace(/\\/+$/, "");
  // Existing channels may use the origin; explicit API/proxy paths stay intact.
  return /^https?:\\/\\/[^/]+$/i.test(base) ? base + "/api" : base;
}

`;
let candidate = upstream;
for (const [from, to] of [
  ['version: "1.2.1",', 'version: "1.2.2",'],
  ['export function buildSubmitRequest(ctx) {', baseNormalizer + 'export function buildSubmitRequest(ctx) {'],
  ['ctx.baseUrl + "/minimax/v2/video_generation"', 'metasoAPIBase(ctx.baseUrl) + "/minimax/v2/video_generation"'],
  ['ctx.baseUrl + "/minimax/v2/query/video_generation/"', 'metasoAPIBase(ctx.baseUrl) + "/minimax/v2/query/video_generation/"'],
]) {
  if (candidate.split(from).length !== 2) throw new Error('MiniMax-Meta patch anchor changed; review required: ' + from);
  candidate = candidate.replace(from, to);
}
const manifest = {
  format:'minimax-meta-base-url-compat/v1', key:'minimax-meta', version:'1.2.2',
  upstreamVersion:'1.2.1', upstreamSHA256,
  provenance:'Exact locally active 1.2.1 source, also matched the investigated production source; retained without modifying it',
  inputs:{'upstream-1.2.1.plugin.js':sha(upstream),'build.mjs':sha(read('build.mjs'))},
  file:'minimax-meta.plugin.js', sha256:sha(candidate),
  scope:'Only version identity and submit/query API Base normalization; input, usage, price, auth, result and download behavior stay unchanged',
};
for (const [file, content] of [
  ['dist/minimax-meta.plugin.js', candidate],
  ['dist/manifest.json', JSON.stringify(manifest,null,2)+'\n'],
]) {
  if (process.argv.includes('--check')) {
    if (read(file) !== content) throw new Error('Stale generated file: ' + file);
  } else {
    fs.mkdirSync(new URL('dist/',root),{recursive:true});
    fs.writeFileSync(new URL(file,root),content);
  }
}
console.log(JSON.stringify(manifest));

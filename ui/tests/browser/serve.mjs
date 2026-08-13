/**
 * Minimal static server mirroring the real serving overlay so pages resolve
 * exactly as they do from the Rust binary:
 *   EeAssets (ee/ui/web) -> EeComponents (/components/ -> ee/ui/components)
 *     -> OssAssets (oss/ui/web) -> CommonAssets (/common/ -> oss/ui/common)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const DEFAULT_LAYERS = ['ee/ui/web', 'oss/ui/web'];
const COMMON = join(ROOT, 'oss/ui/common');
/** The EE components mount — enterprise page components and their host geometry. */
const EE_COMPONENTS = join(ROOT, 'ee/ui/components');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.map': 'application/json',
};

async function tryFile(p) {
  try { if ((await stat(p)).isFile()) return p; } catch {}
  return null;
}

async function resolvePath(urlPath, layers) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  if (p.startsWith('/common/')) return tryFile(join(COMMON, p.slice('/common/'.length)));
  if (p.startsWith('/components/')) return tryFile(join(EE_COMPONENTS, p.slice('/components/'.length)));
  for (const layer of layers) {
    const hit = await tryFile(join(layer, p.slice(1)));
    if (hit) return hit;
  }
  return null;
}

export function startServer(root, port = 0, layerDirs = DEFAULT_LAYERS) {
  const layers = layerDirs.map((d) => join(ROOT, d));
  const server = createServer(async (req, res) => {
    const file = await resolvePath(req.url, layers);
    if (!file) { res.writeHead(404, {'content-type':'text/plain'}); res.end('not found: ' + req.url); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((r) => server.listen(port, () => r({ server, port: server.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer(ROOT, Number(process.env.PORT) || 7788);
  console.log(`serving ${ROOT} on http://localhost:${port}`);
}

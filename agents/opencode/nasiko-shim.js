// Nasiko's A2A client sends PascalCase JSON-RPC method names (SendMessage,
// SendStreamingMessage — see oss/types/src/a2a.rs) matching the a2a-lf crate's
// convention. a2a-opencode implements the official A2A spec's slash-form names
// (message/send, message/stream) via @a2a-js/sdk. This shim sits in front of
// a2a-opencode and rewrites the method name so Nasiko's orchestrator can call
// it unmodified. Everything else (streaming, headers, REST, agent card) passes
// through untouched.
const http = require('http');

const LISTEN_PORT = process.env.SHIM_PORT || 8000;
const TARGET_PORT = process.env.WRAPPED_PORT || 3000;
const TARGET_HOST = '127.0.0.1';
const RPC_PATH = '/a2a/jsonrpc';

const METHOD_ALIASES = {
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  CancelTask: 'tasks/cancel',
  ListTasks: 'tasks/list',
};

function forward(req, res, overrideBody) {
  const headers = { ...req.headers };
  if (overrideBody !== undefined) {
    headers['content-length'] = Buffer.byteLength(overrideBody);
  }
  const proxyReq = http.request(
    { hostname: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end(String(err));
  });
  if (overrideBody !== undefined) proxyReq.end(overrideBody);
  else req.pipe(proxyReq);
}

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === RPC_PATH) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let out = body;
        try {
          const parsed = JSON.parse(body);
          if (parsed && METHOD_ALIASES[parsed.method]) {
            parsed.method = METHOD_ALIASES[parsed.method];
            out = JSON.stringify(parsed);
          }
        } catch (_) {
          // not parseable JSON — forward untouched
        }
        forward(req, res, out);
      });
      return;
    }
    forward(req, res);
  })
  .listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[nasiko-shim] :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT} (aliasing A2A method names)`);
  });

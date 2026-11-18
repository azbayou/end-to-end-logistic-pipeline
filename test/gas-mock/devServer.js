'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createGasRuntime } = require('./gasRuntime');

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function buildClientShimScript() {
  return `<script>
(function () {
  function createRunner(state) {
    const cfg = state || { onSuccess: null, onFailure: null, userObject: undefined };
    const target = {
      withSuccessHandler(fn) {
        return createRunner({ ...cfg, onSuccess: fn });
      },
      withFailureHandler(fn) {
        return createRunner({ ...cfg, onFailure: fn });
      },
      withUserObject(obj) {
        return createRunner({ ...cfg, userObject: obj });
      }
    };
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return function (...args) {
          fetch('/__gas_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: String(prop), args })
          })
            .then((res) => res.json())
            .then((payload) => {
              if (payload && payload.ok) {
                if (typeof cfg.onSuccess === 'function') {
                  cfg.onSuccess(payload.result, cfg.userObject);
                }
              } else {
                const err = new Error((payload && payload.error) || 'GAS RPC error');
                if (typeof cfg.onFailure === 'function') {
                  cfg.onFailure(err, cfg.userObject);
                }
              }
            })
            .catch((err) => {
              if (typeof cfg.onFailure === 'function') {
                cfg.onFailure(err, cfg.userObject);
              }
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner();
  window.google.script.url = {
    getLocation(cb) {
      const params = new URLSearchParams(window.location.search);
      const parameter = {};
      const parameters = {};
      params.forEach((v, k) => {
        if (!(k in parameter)) parameter[k] = v;
        if (!parameters[k]) parameters[k] = [];
        parameters[k].push(v);
      });
      cb({ parameter, parameters, hash: window.location.hash.replace(/^#/, '') });
    }
  };
  window.google.script.history = {
    push(stateObj, params, hash) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : window.location.search;
      const h = hash ? '#' + hash : '';
      window.history.pushState(stateObj || null, '', qs + h);
    },
    replace(stateObj, params, hash) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : window.location.search;
      const h = hash ? '#' + hash : '';
      window.history.replaceState(stateObj || null, '', qs + h);
    },
    setChangeHandler() {}
  };
})();
</script>`;
}

function injectShimIntoHtml(html) {
  const shimTag = buildClientShimScript();
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_, attrs) => `<head${attrs}>\n${shimTag}`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => `${shimTag}\n</head>`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, (_, attrs) => `<body${attrs}>\n${shimTag}`);
  }
  return `${shimTag}\n${html}`;
}

function escapeHtmlBasic(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFallbackDiagnosticHtml(e, runtime) {
  const view = (e && e.parameter && e.parameter.view) || 'dashboard';
  const files = (runtime.loadedFiles || []).map(escapeHtmlBasic).join(', ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GAS Emulator — doGet(e) Not Implemented</title>
</head>
<body>
  <main id="gas-diagnostic">
    <h1>doGet(e) not implemented yet</h1>
    <p id="diagnostic-view">Requested view: <code>${escapeHtmlBasic(view)}</code></p>
    <p id="diagnostic-files">Loaded .gs files: <code>${files}</code></p>
  </main>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error('Request body exceeds 5MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload: ' + err.message));
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function startDevServer(options = {}) {
  const port = options.port !== undefined ? Number(options.port) : 0;
  const host = options.host || '127.0.0.1';

  let resolvedSnapshotPath = options.snapshotPath;
  if (
    resolvedSnapshotPath === undefined &&
    !options.ordersRows &&
    !options.shippersRows
  ) {
    const defaultSnapshot = path.resolve(
      __dirname,
      '../fixtures/sheet_snapshot.json'
    );
    if (fs.existsSync(defaultSnapshot)) {
      resolvedSnapshotPath = defaultSnapshot;
    }
  } else if (resolvedSnapshotPath === null) {
    resolvedSnapshotPath = undefined;
  }

  const runtime = createGasRuntime({
    snapshotPath: resolvedSnapshotPath,
    ordersRows: options.ordersRows,
    shippersRows: options.shippersRows,
    reportRows: options.reportRows,
    reportFormulas: options.reportFormulas,
    opLogsRows: options.opLogsRows,
    activeUserEmail: options.activeUserEmail,
    spreadsheetId: options.spreadsheetId,
    srcDir: options.srcDir,
    hasActiveSpreadsheet: options.hasActiveSpreadsheet,
    now: options.now
  });

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${host}`);

      if (req.method === 'GET' && parsedUrl.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        req.method === 'GET' &&
        (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')
      ) {
        const parameter = {};
        const parameters = {};
        for (const [k, v] of parsedUrl.searchParams.entries()) {
          if (!(k in parameter)) parameter[k] = v;
          if (!parameters[k]) parameters[k] = [];
          parameters[k].push(v);
        }
        const e = {
          parameter,
          parameters,
          queryString: parsedUrl.search.replace(/^\?/, ''),
          contentLength: -1,
          pathInfo: ''
        };

        let rawHtml;
        if (runtime.hasFunction('doGet')) {
          const out = runtime.invoke('doGet', e);
          rawHtml =
            typeof out === 'string'
              ? out
              : out && typeof out.getContent === 'function'
              ? out.getContent()
              : String(out || '');
        } else {
          rawHtml = renderFallbackDiagnosticHtml(e, runtime);
        }

        const html = injectShimIntoHtml(rawHtml);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/__gas_rpc') {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (parseErr) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: parseErr.message }));
          return;
        }

        const fn = payload && payload.fn;
        const args = payload && payload.args !== undefined ? payload.args : [];
        if (typeof fn !== 'string' || !Array.isArray(args)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'RPC payload must contain string "fn" and array "args".'
            })
          );
          return;
        }

        try {
          const result = runtime.invoke(fn, ...args);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(
            JSON.stringify({
              ok: true,
              result: result === undefined ? null : result
            })
          );
        } catch (rpcErr) {
          const message =
            rpcErr && typeof rpcErr.message === 'string'
              ? rpcErr.message
              : String(rpcErr);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(JSON.stringify({ ok: false, error: message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err && err.message ? err.message : String(err)
        })
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    server,
    url,
    port: actualPort,
    runtime,
    close
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let port = Number(process.env.PORT || 3000);
  let snapshotPath;

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg.startsWith('--snapshot=')) {
      snapshotPath = arg.slice('--snapshot='.length);
    }
  }

  startDevServer({ port, snapshotPath })
    .then((dev) => {
      console.log(`GAS Dev Server listening at ${dev.url}`);
      const shutdown = async () => {
        await dev.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('Failed to start GAS Dev Server:', err);
      process.exit(1);
    });
}

module.exports = { startDevServer };

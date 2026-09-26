import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
/** Wire-level pieces of the vendor-plugin consent: the terminal pages and the loopback listener. */

const TERMINAL_HEADINGS = {
  ok: 'Connected. You can close this tab and go back to Frink.',
  cancelled: 'Sign-in cancelled. You can close this tab and go back to Frink.',
  stale: 'This sign-in link is out of date. Go back to Frink and press Connect again.',
} as const;

/** Where the browser lands when the chain ends on Frink's loopback; a tools leg with a next hop never shows one. */
function terminalPage(kind: keyof typeof TERMINAL_HEADINGS): string {
  return `<!doctype html><meta charset="utf-8"><title>Frink</title>
<body style="font-family:system-ui;background:#0a0a0a;color:#e8e8e8;display:grid;place-items:center;height:100vh;margin:0">
<h3>${TERMINAL_HEADINGS[kind]}</h3>
</body>`;
}

export type LoopbackCallback = {
  code: Promise<string>;
  /** The bound port — ephemeral when 0 was requested; resolved before any redirect_uri is minted. */
  port: Promise<number>;
  cancel: () => void;
};

/** Bind the loopback listener. With `nextHop`, a granted callback 302s there before its exchange runs (the account leg follows in the same tab). */
export function waitForCallback(
  port: number,
  expectedState: string,
  opts: { timeoutMs: number; callbackPath: string; cancelledMessage: string; nextHop?: string },
): LoopbackCallback {
  const { timeoutMs, callbackPath: CALLBACK_PATH, cancelledMessage: CANCELLED, nextHop } = opts;
  let cancel = () => {};
  let resolvePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const boundPort = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  const code = new Promise<string>((resolve, reject) => {
    let server: Server | null = null;
    let listening = false;
    // Close waits for open sockets: drop them so the registered port frees immediately. A close
    // requested before the bind settles waits for it — closing a still-binding server never calls back.
    const closeServer = (done: () => void) => {
      if (!server) return done();
      if (!listening) {
        server.once('listening', () => closeServer(done));
        server.once('error', () => done());
        return;
      }
      server.closeAllConnections();
      server.close(done);
    };
    const timer = setTimeout(() => {
      closeServer(() => reject(new Error('Timed out waiting for the browser authorization.')));
    }, timeoutMs);
    cancel = () => {
      clearTimeout(timer);
      closeServer(() => reject(new Error(CANCELLED)));
    };
    const finish = (result: { code?: string; error?: string }) => {
      clearTimeout(timer);
      closeServer(() =>
        result.code ? resolve(result.code) : reject(new Error(result.error ?? 'Authorization failed')),
      );
    };
    // Settle only once the page has been flushed: closing drops every socket, including this one.
    const page = (res: ServerResponse, kind: keyof typeof TERMINAL_HEADINGS, then?: () => void) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(terminalPage(kind), then);
    };
    server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      } catch {
        // A malformed request target must 404, never throw through the listener into the process.
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Connection', 'close');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      // Another consent's state (a stale tab of a superseded attempt) is answered but never settles this one.
      if (url.searchParams.get('state') !== expectedState) return page(res, 'stale');
      const code = url.searchParams.get('code');
      // No code and no error names nothing the user did but decline.
      if (!code) {
        return page(res, 'cancelled', () =>
          finish({ error: url.searchParams.get('error') || 'access_denied' }),
        );
      }
      if (nextHop) {
        res.writeHead(302, { Location: nextHop }).end(() => finish({ code }));
        return;
      }
      page(res, 'ok', () => finish({ code }));
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const error =
        err.code === 'EADDRINUSE' && port !== 0
          ? new Error(`Port ${port} is in use — close any other pending login for this plugin and retry.`)
          : err;
      rejectPort(error);
      reject(error);
    });
    server.on('listening', () => {
      listening = true;
      resolvePort((server?.address() as AddressInfo).port);
    });
    // A vendor-registered client pins its port; a client Frink registers binds any free one. 127.0.0.1 keeps the code off the LAN.
    server.listen(port, '127.0.0.1');
  });
  // A listen error can reject before the caller awaits; mark both promises handled.
  void code.catch(() => {});
  void boundPort.catch(() => {});
  return { code, port: boundPort, cancel };
}

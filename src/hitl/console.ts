import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { HandoffSession } from './session.js';
import type { RunLog, RunEvent } from '../run/log.js';

/**
 * Minimal operator console.
 *
 * The session stays in the runner process; frames go out over SSE and input
 * comes back over POST. This matches attaching to a remote, containerised
 * session, where the operator is not on the same machine. No dependencies,
 * and the transport can be inspected with curl.
 */
export class OperatorConsole {
  private server?: Server;
  private clients: import('node:http').ServerResponse[] = [];
  private seen = 0;
  private lastFrameAt = 0;

  /** The port actually bound — may differ from the requested one. */
  port: number;

  constructor(
    private readonly session: HandoffSession,
    private readonly log: RunLog,
    requestedPort = 8790,
  ) {
    this.port = requestedPort;
  }

  private broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  private state(): { holder: string; control: string } {
    return { holder: this.session.control.holder, control: this.session.control.state };
  }

  async start(): Promise<string> {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'console.html'), 'utf8');

    this.session.onFrame((frame) => { this.lastFrameAt = Date.now(); this.broadcast({ frame }); });
    this.session.control.onChange(() => this.broadcast({ state: this.state() }));

    // Stream new events. Each client also gets the backlog on connect.
    setInterval(() => {
      while (this.seen < this.log.events.length) {
        const e: RunEvent = this.log.events[this.seen++]!;
        this.broadcast({ event: { actor: e.actor, kind: e.kind, detail: e.detail } });
      }
    }, 250).unref();

    // Periodic still, since CDP only sends screencast frames on repaint.
    setInterval(() => {
      if (!this.clients.length || Date.now() - this.lastFrameAt < 900) return;
      this.session.snapshot().then((f) => { this.lastFrameAt = Date.now(); this.broadcast({ frame: f }); }).catch(() => {});
    }, 1000).unref();

    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
      }

      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        this.clients.push(res);
        res.write(`data: ${JSON.stringify({ state: this.state() })}\n\n`);
        if (this.session.escalation) res.write(`data: ${JSON.stringify({ escalation: this.session.escalation })}\n\n`);
        // Backlog up to `seen`; later events arrive via the live stream.
        for (const e of this.log.events.slice(0, this.seen)) {
          res.write(`data: ${JSON.stringify({ event: { actor: e.actor, kind: e.kind, detail: e.detail } })}\n\n`);
        }
        this.session.snapshot()
          .then((f) => res.write(`data: ${JSON.stringify({ frame: f })}\n\n`))
          .catch(() => {});
        req.on('close', () => { this.clients = this.clients.filter((c) => c !== res); });
        return;
      }

      const body = await new Promise<string>((resolve) => {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
      });

      if (url.pathname === '/control') {
        const { action } = JSON.parse(body || '{}') as { action: string };
        if (action === 'take') {
          if (this.session.control.state === 'agent') this.session.control.requestPause();
          // Hand over here only when no loop is running; otherwise the loop
          // yields at its next step boundary.
          if (this.session.control.pauseRequested && !this.session.agentActive) this.session.yield();
        } else if (action === 'handback') {
          this.session.control.requestResume();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(this.state()));
      }

      if (url.pathname === '/input') {
        const outcome = await this.session.operatorInput(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ outcome }));
      }

      res.writeHead(404); res.end();
    });

    // If the port is taken (e.g. by a leftover console), use the next free one.
    const first = this.port;
    for (let attempt = 0; attempt < 40; attempt++) {
      const port = first + attempt;
      const bound = await new Promise<boolean>((resolve) => {
        const onError = (e: NodeJS.ErrnoException) => {
          this.server!.removeListener('error', onError);
          if (e.code === 'EADDRINUSE') return resolve(false);
          throw e;
        };
        this.server!.once('error', onError);
        // Loopback only: the console forwards input into a live session and has no auth.
        this.server!.listen(port, '127.0.0.1', () => { this.server!.removeListener('error', onError); resolve(true); });
      });
      if (bound) { this.port = port; break; }
      if (attempt === 39) throw new Error(`no free port for the operator console (tried ${first}-${first + 39})`);
    }
    await this.session.startStreaming();
    return `http://127.0.0.1:${this.port}/`;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

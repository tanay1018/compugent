import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { HandoffSession } from './session.js';
import type { RunLog, RunEvent } from '../run/log.js';

/**
 * A minimal but REAL operator console.
 *
 * Deliberately a thin client over a channel rather than an embedded browser.
 * The session lives in the runner process; frames go out over SSE and input
 * comes back over POST. That is architecturally the same shape as attaching to
 * a containerised session in production, which an embedded-browser console
 * would not be — it would only ever work when the operator is on the same
 * machine as the automation, which in a bank they never are.
 *
 * Zero dependencies: SSE is just a long-lived HTTP response, and it makes the
 * whole transport inspectable with curl.
 */
export class OperatorConsole {
  private server?: Server;
  private clients: import('node:http').ServerResponse[] = [];
  private seen = 0;

  constructor(
    private readonly session: HandoffSession,
    private readonly log: RunLog,
    private readonly port = 8790,
  ) {}

  private broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  private state(): { holder: string; control: string } {
    return { holder: this.session.control.holder, control: this.session.control.state };
  }

  async start(): Promise<string> {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'console.html'), 'utf8');

    this.session.onFrame((frame) => this.broadcast({ frame }));
    this.session.control.onChange(() => this.broadcast({ state: this.state() }));
    // Drain the shared event log so the operator sees the agent's history too
    // -- one log, both actors, which is the point of the actor tag.
    setInterval(() => {
      while (this.seen < this.log.events.length) {
        const e: RunEvent = this.log.events[this.seen++]!;
        this.broadcast({ event: { actor: e.actor, kind: e.kind, detail: e.detail } });
      }
    }, 250).unref();

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
          // Nothing is executing while we sit at an escalation, so the boundary
          // is immediate. Mid-run this waits for the executor to yield.
          if (this.session.control.pauseRequested) this.session.yield();
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

    await new Promise<void>((r) => this.server!.listen(this.port, r));
    await this.session.startStreaming();
    return `http://localhost:${this.port}/`;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

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
  private lastFrameAt = 0;

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

    this.session.onFrame((frame) => { this.lastFrameAt = Date.now(); this.broadcast({ frame }); });
    this.session.control.onChange(() => this.broadcast({ state: this.state() }));

    // Stream NEW events. The backlog is replayed per client on connect, since
    // an operator arriving mid-incident needs the history that led here.
    setInterval(() => {
      while (this.seen < this.log.events.length) {
        const e: RunEvent = this.log.events[this.seen++]!;
        this.broadcast({ event: { actor: e.actor, kind: e.kind, detail: e.detail } });
      }
    }, 250).unref();

    // Heartbeat still. CDP only emits a screencast frame on repaint, so a
    // paused session -- exactly when an operator is looking -- produces none.
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
        // Backlog: the agent's history is what explains why we stopped here.
        // Only up to `seen` — anything past it is still queued for the live
        // stream, and replaying it here would show every event twice.
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
          // Only hand over here when nothing is executing. With a loop running,
          // the loop yields at its own step boundary — the console must not do
          // it on the loop's behalf, or control moves mid-action.
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

    await new Promise<void>((r) => this.server!.listen(this.port, r));
    await this.session.startStreaming();
    return `http://localhost:${this.port}/`;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

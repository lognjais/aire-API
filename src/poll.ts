import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

interface Tally {
  counts: Record<string, { yes: number; no: number }>;
  total: number;
}

interface PollDef {
  id: string;
  questions: string[];
}

export class PollRoom extends DurableObject<Env> {
  private def: PollDef | null = null;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pollId = url.searchParams.get('pollId') ?? '';

    if (url.pathname === '/results') {
      await this.loadDef(pollId);
      if (!this.def) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const tally = await this.getTally();
      return new Response(JSON.stringify(tally), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/ws') {
      await this.loadDef(pollId);
      if (!this.def) return new Response('not found', { status: 404 });

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);

      const tally = await this.getTally();
      server.send(
        JSON.stringify({ type: 'init', questions: this.def.questions, tally }),
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: { type?: string; voterId?: unknown; answers?: unknown };
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    if (msg.type === 'vote') {
      await this.handleVote(ws, msg);
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    try { ws.close(code, 'closed'); } catch { /* ignore */ }
  }

  private async loadDef(pollId: string): Promise<void> {
    if (this.def && this.def.id === pollId) return;
    const row = await this.env.DB.prepare('SELECT id, questions FROM polls WHERE id = ?')
      .bind(pollId)
      .first<{ id: string; questions: string }>();
    if (!row) {
      this.def = null;
      return;
    }
    this.def = { id: row.id, questions: JSON.parse(row.questions) };
  }

  private async getTally(): Promise<Tally> {
    const stored = await this.ctx.storage.get<Tally>('tally');
    if (stored) return stored;
    const counts: Tally['counts'] = {};
    if (this.def) {
      for (let i = 0; i < this.def.questions.length; i++) {
        counts[String(i)] = { yes: 0, no: 0 };
      }
    }
    return { counts, total: 0 };
  }

  private async handleVote(
    ws: WebSocket,
    msg: { voterId?: unknown; answers?: unknown },
  ): Promise<void> {
    if (!this.def) {
      ws.send(JSON.stringify({ type: 'error', message: 'poll not loaded' }));
      return;
    }
    const voterId = typeof msg.voterId === 'string' ? msg.voterId : '';
    if (voterId.length < 8 || voterId.length > 64) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid voterId' }));
      return;
    }
    if (!msg.answers || typeof msg.answers !== 'object') {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid answers' }));
      return;
    }
    const answers = msg.answers as Record<string, unknown>;
    const normalized: Record<string, 'yes' | 'no'> = {};
    for (let i = 0; i < this.def.questions.length; i++) {
      const key = String(i);
      const a = answers[key] ?? answers[i as unknown as string];
      if (a !== 'yes' && a !== 'no') {
        ws.send(JSON.stringify({ type: 'error', message: `missing answer for q${i}` }));
        return;
      }
      normalized[key] = a;
    }

    try {
      await this.env.DB.prepare(
        'INSERT INTO votes (poll_id, voter_id, answers, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(this.def.id, voterId, JSON.stringify(normalized), Date.now())
        .run();
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (m.includes('UNIQUE') || m.includes('constraint')) {
        ws.send(JSON.stringify({ type: 'error', message: 'already voted' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'error', message: 'vote failed' }));
      return;
    }

    const tally = await this.getTally();
    tally.total += 1;
    for (const [k, a] of Object.entries(normalized)) {
      if (!tally.counts[k]) tally.counts[k] = { yes: 0, no: 0 };
      tally.counts[k][a] += 1;
    }
    await this.ctx.storage.put('tally', tally);

    ws.send(JSON.stringify({ type: 'voted' }));
    const payload = JSON.stringify({ type: 'tally', tally });
    for (const s of this.ctx.getWebSockets()) {
      try { s.send(payload); } catch { /* ignore */ }
    }
  }
}

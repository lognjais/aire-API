import { PollRoom } from './poll';

export { PollRoom };

export interface Env {
  DB: D1Database;
  POLL_ROOM: DurableObjectNamespace<PollRoom>;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers as Record<string, string> | undefined) },
  });
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 0x1f];
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'aire-api', version: 2 });
    }

    if (req.method === 'POST' && url.pathname === '/polls') {
      const body = (await req.json().catch(() => null)) as {
        title?: unknown;
        questions?: unknown;
      } | null;
      if (!body || !Array.isArray(body.questions)) {
        return json({ error: 'questions[] required' }, { status: 400 });
      }
      const questions = body.questions
        .map((q) => String(q).trim())
        .filter((q) => q.length > 0)
        .slice(0, 20);
      if (questions.length === 0) return json({ error: 'no valid questions' }, { status: 400 });
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';

      const id = newId();
      await env.DB.prepare(
        'INSERT INTO polls (id, title, questions, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(id, title, JSON.stringify(questions), Date.now())
        .run();
      return json({ id, title, questions });
    }

    const pollMatch = url.pathname.match(/^\/polls\/([a-z0-9]{4,16})$/);
    if (pollMatch && req.method === 'GET') {
      const id = pollMatch[1];
      const row = await env.DB.prepare(
        'SELECT id, title, questions, created_at FROM polls WHERE id = ?',
      )
        .bind(id)
        .first<{ id: string; title: string; questions: string; created_at: number }>();
      if (!row) return json({ error: 'not found' }, { status: 404 });
      return json({
        id: row.id,
        title: row.title,
        questions: JSON.parse(row.questions),
        createdAt: row.created_at,
      });
    }

    const resultsMatch = url.pathname.match(/^\/polls\/([a-z0-9]{4,16})\/results$/);
    if (resultsMatch && req.method === 'GET') {
      const id = resultsMatch[1];
      const stub = env.POLL_ROOM.get(env.POLL_ROOM.idFromName(id));
      const r = await stub.fetch(new Request(`https://do/results?pollId=${id}`));
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const wsMatch = url.pathname.match(/^\/polls\/([a-z0-9]{4,16})\/ws$/);
    if (wsMatch) {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = wsMatch[1];
      const exists = await env.DB.prepare('SELECT 1 FROM polls WHERE id = ?').bind(id).first();
      if (!exists) return new Response('not found', { status: 404 });
      const stub = env.POLL_ROOM.get(env.POLL_ROOM.idFromName(id));
      return stub.fetch(new Request(`https://do/ws?pollId=${id}`, req));
    }

    return json({ error: 'not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

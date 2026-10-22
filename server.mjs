import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createAgent({ secret, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Set AGENT_GAMES_HMAC_SECRET to the platform-generated secret.');
  }
  const sign = raw => createHmac('sha256', secret).update(raw).digest('hex');
  const nonces = new Map();
  return http.createServer(async (req, res) => {
    function reply(status, body) {
      const raw = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json',
        'x-agent-games-signature': sign(raw), 'cache-control': 'no-store' });
      res.end(raw);
    }
    if (req.method === 'GET' && req.url === '/health') {
      return reply(200, { ok: true, stage: 'preflight-only', competitionReady: false });
    }
    if (req.method !== 'POST' || req.url !== '/agent') return reply(404, { error: 'NOT_FOUND' });
    let raw;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return reply(413, { error: 'BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks);
    } catch { return reply(400, { error: 'BODY_READ_FAILED' }); }
    // Assumption pending live preflight: SHA-256 HMAC, hex header, optional sha256= prefix.
    const header = req.headers['x-agent-games-signature'];
    const signature = typeof header === 'string' ? header.replace(/^sha256=/, '') : '';
    if (!/^[a-fA-F0-9]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(raw), 'hex'))) {
      return reply(401, { error: 'INVALID_SIGNATURE' });
    }
    let task;
    try { task = JSON.parse(raw.toString('utf8')); }
    catch { return reply(400, { error: 'INVALID_JSON' }); }
    if (!task || typeof task !== 'object' || Array.isArray(task)) return reply(400, { error: 'INVALID_ENVELOPE' });
    const issued = typeof task.issued_at === 'string' ? Date.parse(task.issued_at) : NaN;
    if (!Number.isFinite(issued) || Math.abs(now() - issued) > 300000) return reply(400, { error: 'STALE_REQUEST' });
    if (task.type === 'agent-games.preflight.v1') {
      if (typeof task.nonce !== 'string' || !task.nonce || task.nonce.length > 256) return reply(400, { error: 'INVALID_NONCE' });
      for (const [nonce, expires] of nonces) if (expires <= now()) nonces.delete(nonce);
      if (nonces.has(task.nonce)) return reply(409, { error: 'REPLAY' });
      if (nonces.size >= 10000) return reply(503, { error: 'BUSY' });
      nonces.set(task.nonce, now() + 600000);
      return reply(200, { ok: true, protocolVersion: 'v1' });
    }
    // No invented decisions or proofs. Do not enter scored rounds with this bootstrap.
    return reply(503, { error: 'COMPETITION_NOT_IMPLEMENTED' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAgent({ secret: process.env.AGENT_GAMES_HMAC_SECRET });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('ProofGuard preflight server started'));
}

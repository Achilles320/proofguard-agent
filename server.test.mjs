import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAgent } from './server.mjs';

test('authenticated transport, replay protection and honest readiness', async t => {
  const secret = 'local-test-secret-not-for-production';
  const server = createAgent({ secret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sign = body => createHmac('sha256', secret).update(body).digest('hex');
  const body = JSON.stringify({ type: 'agent-games.preflight.v1', issued_at: new Date().toISOString(), nonce: 'unique' });
  const send = (raw, sig = sign(raw)) => fetch(url + '/agent', { method: 'POST', body: raw, headers: { 'x-agent-games-signature': sig } });
  const response = await send(body);
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(raw), { ok: true, protocolVersion: 'v1' });
  assert.equal(response.headers.get('x-agent-games-signature'), sign(raw));
  assert.equal((await send(body)).status, 409);
  assert.equal((await send(body + ' ', sign(body))).status, 401);
  assert.equal((await send(body, 'invalid')).status, 401);
  assert.equal((await send('{')).status, 400);
  assert.equal((await send(JSON.stringify({ type: 'agent-games.preflight.v1', issued_at: '2000-01-01', nonce: 'old' }))).status, 400);
  assert.equal((await send(JSON.stringify({ type: 'agent-games.proof-gatekeeper.v1', issued_at: new Date().toISOString() }))).status, 503);
  assert.equal((await (await fetch(url + '/health')).json()).competitionReady, false);
});

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { AgentError, Store, authenticate, signature, createHandler } from './agent.js';

const config = {
  secret: process.env.AGENT_GAMES_HMAC_SECRET || '',
  secretEncoding: process.env.HMAC_SECRET_ENCODING || 'utf8',
  signatureEncoding: process.env.HMAC_SIGNATURE_ENCODING || 'hex',
  apiKey: process.env.OPENAI_API_KEY || '', model: process.env.OPENAI_MODEL || 'gpt-6-luna',
  mode: process.env.AGENT_MODE || 'preflight',
  modelTimeout: Number(process.env.OPENAI_TIMEOUT_MS || 12000),
  maxCalls: Number(process.env.MAX_MODEL_CALLS_PER_DAY || 100)
};
if (!['utf8', 'hex', 'base64'].includes(config.secretEncoding) ||
    !['hex', 'base64'].includes(config.signatureEncoding) ||
    !['preflight', 'practice'].includes(config.mode) ||
    !Number.isInteger(config.modelTimeout) || config.modelTimeout < 100 || config.modelTimeout > 45000 ||
    !Number.isInteger(config.maxCalls) || config.maxCalls < 1) throw new Error('INVALID_CONFIG');
const store = new Store(process.env.STATE_PATH || './data/state.json');
const handle = createHandler(config, store);
function send(res, code, value, signed = false) {
  const raw = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(signed ? { 'x-agent-games-signature': signature(raw, config) } : {}) });
  res.end(raw);
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && ['/', '/healthz'].includes(req.url)) {
    return send(res, 200, { service: 'ProofGuard', version: '0.1.0', status: 'running',
      mode: config.mode, hmacConfigured: Boolean(config.secret), openaiConfigured: Boolean(config.apiKey),
      competitionReady: false, proofIntegration: 'pending-official-artifacts',
      stateDurability: 'requires-persistent-disk' });
  }
  if (req.method !== 'POST' || req.url !== '/agent') return send(res, 404, { error: 'NOT_FOUND' });
  let authenticated = false;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new AgentError(413, 'BODY_TOO_LARGE');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    authenticate(raw, req.headers['x-agent-games-signature'], config); authenticated = true;
    let task;
    try { task = JSON.parse(raw.toString('utf8')); } catch { throw new AgentError(400, 'INVALID_JSON'); }
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new AgentError(400, 'INVALID_TASK');
    const response = await handle(task, createHash('sha256').update(raw).digest('hex'));
    send(res, 200, response, true);
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 500;
    const code = e instanceof AgentError ? e.message : 'INTERNAL_ERROR';
    console.error(JSON.stringify({ event: 'request_failed', status, code }));
    send(res, status, { error: code }, authenticated);
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('ProofGuard listening'));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20000).unref();
});

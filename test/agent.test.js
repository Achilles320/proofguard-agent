import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, signature, authenticate, inspect, createHandler, reasonWithOpenAI } from '../src/agent.js';
const config = { secret: 'test-secret-only', secretEncoding: 'utf8', signatureEncoding: 'hex',
  mode: 'practice', modelTimeout: 1000, maxCalls: 3, apiKey: 'fake-test-key', model: 'test' };
const input = { registered_vk: '0xaa', proof_vk: '0xaa', minimum: '1000', public_balance: '1460',
  expiry_block: 200, current_block: 100, recipient: '0xbb', condition_recipient: '0xbb',
  amount: '500', max_transfer: '1000', proof_tx: '0xcc' };
const task = (id, i = input) => ({ type: 'agent-games.proof-gatekeeper.v1', mode: 'practice', task_id: id,
  issued_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 60000).toISOString(), input: i });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'proofguard-')); t.after(() => rmSync(dir, { recursive: true }));
  return new Store(join(dir, 'state.json'));
}
test('HMAC authenticates exact raw bytes and rejects tampering', () => {
  const raw = '{"test":1}', sig = signature(raw, config);
  authenticate(raw, sig, config);
  assert.throws(() => authenticate('{"test":2}', sig, config), /INVALID_SIGNATURE/);
  assert.throws(() => authenticate(raw, '', config), /INVALID_SIGNATURE/);
});
test('all seven documented classifications, integer precision and input validation', () => {
  assert.equal(inspect(input, {}).reason_code, 'VALID_CONDITION');
  for (const [change, code] of [
    [{ proof_vk: '0xdd' }, 'VK_SUBSTITUTION'], [{ public_balance: '999' }, 'THRESHOLD_MISMATCH'],
    [{ current_block: 201 }, 'EXPIRED_CONDITION'], [{ recipient: '0xdd' }, 'RECIPIENT_MISMATCH'],
    [{ amount: '1001' }, 'AMOUNT_OVERFLOW']
  ]) assert.equal(inspect({ ...input, ...change }, {}).reason_code, code);
  assert.equal(inspect(input, { '0xcc': true }).reason_code, 'PROOF_REUSED');
  assert.equal(inspect({ ...input, minimum: '9007199254740993', public_balance: '9007199254740992' }, {}).reason_code, 'THRESHOLD_MISMATCH');
  assert.throws(() => inspect({ ...input, amount: -1 }, {}), /INVALID_INTEGER/);
});
test('duplicates do not call model twice; accepted proofs survive restart; altered task ID fails', async t => {
  const store = setup(t); let calls = 0;
  const infer = async () => { calls++; return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' }; };
  const handler = createHandler(config, store, infer), a = task('a');
  const [first, duplicate] = await Promise.all([handler(a, 'hash'), handler(a, 'hash')]);
  assert.deepEqual(first, duplicate); assert.equal(calls, 1);
  await assert.rejects(handler(a, 'different'), /TASK_ID_CONTENT_CONFLICT/);
  const reloaded = new Store(store.path);
  assert.equal(inspect(input, reloaded.data.acceptedProofs).reason_code, 'PROOF_REUSED');
});
test('formal tasks and missing keys cannot silently return approvals', async t => {
  const handler = createHandler(config, setup(t));
  await assert.rejects(handler({ ...task('b'), mode: 'competition' }, 'h'), /OFFICIAL_PROOF_INTEGRATION_PENDING/);
  await assert.rejects(reasonWithOpenAI(input, false, { ...config, apiKey: '' }), /OPENAI_API_KEY_NOT_CONFIGURED/);
});
test('model disagreement fails; daily call limit is persisted', async t => {
  const store = setup(t);
  const handler = createHandler({ ...config, maxCalls: 1 }, store, async () => ({ decision: 'REJECT', reason_code: 'PROOF_REUSED' }));
  await assert.rejects(handler(task('c'), 'h'), /MODEL_POLICY_DISAGREEMENT/);
  await assert.rejects(handler(task('d'), 'h2'), /DAILY_MODEL_CALL_LIMIT/);
});
test('OpenAI REST response parsing includes message output after reasoning items', async () => {
  const result = await reasonWithOpenAI(input, false, config, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.parse(options.body).text.format.type, 'json_schema');
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"decision":"APPROVE","reason_code":"VALID_CONDITION"}' }] }
    ] }) };
  });
  assert.equal(result.decision, 'APPROVE');
});
test('upstream quota/auth/model errors expose only fixed diagnostic categories', async () => {
  for (const [code, status, expected] of [
    ['insufficient_quota', 429, 'OPENAI_INSUFFICIENT_QUOTA'],
    ['invalid_api_key', 401, 'OPENAI_INVALID_API_KEY'],
    ['model_not_found', 404, 'OPENAI_MODEL_NOT_FOUND'],
    ['unknown-sensitive-upstream-text', 400, 'OPENAI_BAD_REQUEST']
  ]) {
    await assert.rejects(reasonWithOpenAI(input, false, config, async () => ({
      ok: false, status, json: async () => ({ error: { code, message: 'secret-must-not-be-logged' } })
    })), new RegExp(expected));
  }
});
test('DeepSeek uses official endpoint, JSON output, disabled thinking and its own key', async () => {
  const { reasonWithDeepSeek } = await import('../src/agent.js');
  const result = await reasonWithDeepSeek(input, false, { ...config, model: 'deepseek-flash' }, async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'deepseek-flash');
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.max_tokens, 512);
    assert.equal(request.messages.length, 2);
    assert.equal(request.text, undefined);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: '{"decision":"APPROVE","reason_code":"VALID_CONDITION"}'
    } }] }) };
  });
  assert.equal(result.decision, 'APPROVE');
});
test('DeepSeek rejects missing key, empty/truncated/invalid outputs, and reports balance errors', async () => {
  const { reasonWithDeepSeek } = await import('../src/agent.js');
  await assert.rejects(reasonWithDeepSeek(input, false, { ...config, apiKey: '' }), /DEEPSEEK_API_KEY_NOT_CONFIGURED/);
  for (const [content, finish_reason, code] of [
    ['', 'stop', 'EMPTY_RESPONSE'], ['{}', 'length', 'INCOMPLETE_RESPONSE'],
    ['not-json', 'stop', 'INVALID_JSON'], ['{}', 'stop', 'INVALID_DECISION'],
    ['{"decision":"APPROVE","reason_code":"PROOF_REUSED"}', 'stop', 'INVALID_DECISION']
  ]) await assert.rejects(reasonWithDeepSeek(input, false, config, async () => ({ ok: true,
    json: async () => ({ choices: [{ finish_reason, message: { content } }] })
  })), new RegExp('DEEPSEEK_' + code));
  await assert.rejects(reasonWithDeepSeek(input, false, config, async () => ({ ok: false, status: 402 })), /DEEPSEEK_INSUFFICIENT_BALANCE/);
});

test('DeepSeek receives exact ordered findings for large integers, hex case and multiple faults', async () => {
  const { reasonWithDeepSeek } = await import('../src/agent.js');
  const payment = { ...input, proof_vk: '0xAA', minimum: '9007199254740993',
    public_balance: '9007199254740992', amount: '1001' };
  await reasonWithDeepSeek(payment, true, config, async (_, options) => {
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(payload.ordered_tool_checks, [
      { reason_code: 'VK_SUBSTITUTION', failed: false },
      { reason_code: 'THRESHOLD_MISMATCH', failed: true },
      { reason_code: 'PROOF_REUSED', failed: true },
      { reason_code: 'EXPIRED_CONDITION', failed: false },
      { reason_code: 'RECIPIENT_MISMATCH', failed: false },
      { reason_code: 'AMOUNT_OVERFLOW', failed: true }
    ]);
    assert.equal(payload.payment, undefined);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: '{"decision":"REJECT","reason_code":"THRESHOLD_MISMATCH"}'
    } }] }) };
  });
});

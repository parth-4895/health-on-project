const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { localScreening } = require('../screening');
const { createSafetyService } = require('../safety-service');

const secret = 'synthetic-service-key-'.repeat(3);
const id = '10000000-0000-4000-8000-000000000001';
const requestKey = '20000000-0000-4000-8000-000000000001';
const rules = [
  { phrase: 'hurt myself', tier: 'urgent', code: 'synthetic_en' },
  { phrase: 'खुद को नुकसान', tier: 'urgent', code: 'synthetic_hi' },
  { phrase: 'khud ko nuksan', tier: 'urgent', code: 'synthetic_mix' },
  { phrase: 'synthetic concern', tier: 'soon', code: 'synthetic_soon' },
];
let directory;
let rulesFile;
let fetchSpy;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'medbrief-screening-test-'));
  rulesFile = path.join(directory, 'synthetic-rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify(rules));
});
beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected model call'));
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function bypassEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    COMMUNITY_LLM_BYPASS: 'true',
    COMMUNITY_RULES_FILE: rulesFile,
    ...overrides,
  };
}

test.each(['production', undefined, 'staging'])('bypass cannot start in %s', NODE_ENV => {
  expect(() => localScreening(bypassEnv({ NODE_ENV }))).toThrow(/requires NODE_ENV/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test.each(['1', 'TRUE', 'yes'])('ambiguous bypass value %s is rejected', value => {
  expect(() => localScreening(bypassEnv({ COMMUNITY_LLM_BYPASS: value }))).toThrow(/must be true or false/);
});

test.each([undefined, 'false'])('LLM is still required when bypass is %s', flag => {
  expect(() => localScreening(bypassEnv({ COMMUNITY_LLM_BYPASS: flag }))).toThrow('Model configuration required');
});

test('disabled bypass uses both real model-call paths without bypass metadata', async () => {
  fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '{"identifiers":[]}' } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '{"tier":"normal"}' } }) });
  const screen = localScreening(bypassEnv({
    NODE_ENV: 'production', COMMUNITY_LLM_BYPASS: 'false',
    COMMUNITY_MODEL: 'synthetic-model', COMMUNITY_MODEL_VERSION: 'synthetic-version',
  }));
  const result = await screen('A fictional everyday question.');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(result.screening.model).toEqual({ tier: 'normal' });
  expect(result.screening.version).toBe('synthetic-version');
});

test.each(['development', 'test'])('bypass in %s works without Ollama and marks the screening record', async NODE_ENV => {
  const screen = localScreening(bypassEnv({ NODE_ENV, OLLAMA_URL: 'deliberately-invalid' }));
  const result = await screen('A fictional everyday question.');
  expect(result).toMatchObject({
    body: 'A fictional everyday question.', tier: 'normal', state: 'normal',
    screening: { model: { bypassed: true }, version: 'development-llm-bypass-v1' },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('bypass retains deterministic email, number and link removal', async () => {
  const result = await localScreening(bypassEnv())('test@example.invalid 9999999999 https://example.invalid');
  expect(result.body).toBe('[email removed] [number removed] [link removed]');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test.each([
  ['I might hurt myself', 'urgent'],
  ['मैं खुद को नुकसान पहुँचा सकती हूँ', 'urgent'],
  ['Main khud ko nuksan kar sakti hoon', 'urgent'],
  ['A synthetic concern', 'soon'],
])('bypass keeps the rules safety floor: %s', async (text, tier) => {
  const result = await localScreening(bypassEnv())(text);
  expect(result).toMatchObject({ tier, state: 'held', screening: { model: { bypassed: true } } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('bypass still requires a rules configuration', () => {
  expect(() => localScreening(bypassEnv({ COMMUNITY_RULES_FILE: undefined }))).toThrow();
});

test.each([
  ['create_post', { title: 'Synthetic title', body: 'Synthetic body', tags: [] }],
  ['edit_post', { id, title: 'Synthetic title', body: 'Synthetic body', tags: [] }],
  ['create_comment', { postId: id, body: 'Synthetic reply' }],
  ['edit_comment', { id, body: 'Synthetic edit' }],
  ['send_message', { id, body: 'Synthetic private message' }],
])('bypass lets %s reach the existing database workflow without model calls', async (operation, args) => {
  const db = jest.fn().mockResolvedValue({ received: true });
  const app = createSafetyService({ db, screen: localScreening(bypassEnv()), secret });
  const response = await request(app).post('/process').set('X-Community-Service-Key', secret)
    .send({ operation, proof: 'synthetic-internal-proof', args: { ...args, requestKey } });
  expect(response.status).toBe(200);
  const call = db.mock.calls[0];
  expect(call[0]).toBe(operation === 'send_message' ? 'community_private.message_screened' : 'community_private.submit_screened');
  expect(call[1].at(-1)).toMatchObject({ state: 'normal', screening: { model: { bypassed: true } } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('urgent title still holds a post and preserves bypass evidence for title and body', async () => {
  const db = jest.fn().mockResolvedValue({ received: true });
  const app = createSafetyService({ db, screen: localScreening(bypassEnv()), secret });
  const response = await request(app).post('/process').set('X-Community-Service-Key', secret)
    .send({ operation: 'create_post', proof: 'synthetic-internal-proof', args: {
      requestKey, title: 'I might hurt myself', body: 'Synthetic body', tags: [],
    } });
  expect(response.status).toBe(200);
  expect(db.mock.calls[0][1][2]).toMatchObject({ tier: 'urgent', state: 'held', screening: {
    model: { bypassed: true }, title: { model: { bypassed: true } },
  } });
});

test('redaction endpoint keeps pattern removal and authentication in bypass mode', async () => {
  const app = createSafetyService({ db: jest.fn(), screen: localScreening(bypassEnv()), secret });
  expect((await request(app).post('/redact').send({ text: 'Synthetic label' })).status).toBe(403);
  const response = await request(app).post('/redact').set('X-Community-Service-Key', secret)
    .send({ text: 'Synthetic label test@example.invalid' });
  expect(response.body).toEqual({ text: 'Synthetic label [email removed]' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('Gemini Screening Provider', () => {
  test('throws if GEMINI_API_KEY is missing when provider is gemini', () => {
    expect(() => localScreening({
      NODE_ENV: 'production',
      COMMUNITY_RULES_FILE: rulesFile,
      COMMUNITY_LLM_PROVIDER: 'gemini',
    })).toThrow(/GEMINI_API_KEY is not configured/);
  });

  test('screens text using Gemini API for redaction and classification', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ identifiers: ['Apollo Hospital'] }) }] } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ tier: 'normal' }) }] } }],
        }),
      });

    const screen = localScreening({
      NODE_ENV: 'production',
      COMMUNITY_RULES_FILE: rulesFile,
      COMMUNITY_LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'synthetic-gemini-key',
      COMMUNITY_GEMINI_MODEL: 'gemini-3.5-flash-lite',
    });

    const result = await screen('I visited Apollo Hospital for routine checks.');
    expect(result.body).toBe('I visited [identifying detail removed] for routine checks.');
    expect(result.tier).toBe('normal');
    expect(result.state).toBe('normal');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('gemini-3.5-flash-lite:generateContent');
  });

  test('falls back to candidate model when first candidate returns 503', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Overloaded',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ identifiers: [] }) }] } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ tier: 'normal' }) }] } }],
        }),
      });

    const screen = localScreening({
      NODE_ENV: 'production',
      COMMUNITY_RULES_FILE: rulesFile,
      COMMUNITY_LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'synthetic-gemini-key',
      COMMUNITY_GEMINI_MODEL: 'gemini-3.5-flash-lite',
    });

    const result = await screen('Healthy routine question.');
    expect(result.body).toBe('Healthy routine question.');
    expect(result.tier).toBe('normal');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

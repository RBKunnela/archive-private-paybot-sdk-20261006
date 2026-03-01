import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PayBotClient } from '../src/client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PayBotClient.signup()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register, login, create API key, and register bot in one call', async () => {
    // 1. POST /auth/register
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ operatorId: 'op_abc123', email: 'dev@example.com', tier: 'free' }),
    });
    // 2. POST /auth/login
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'jwt_token',
        refreshToken: 'refresh_token',
        expiresIn: 900,
        operator: { id: 'op_abc123', email: 'dev@example.com', tier: 'free' },
      }),
    });
    // 3. POST /api-keys
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'key_1',
        key: 'pb_live_abc123',
        keyPrefix: 'pb_live_abc1',
        operatorId: 'op_abc123',
        permissions: 'all',
        rateLimit: 100,
        createdAt: '2026-03-01T00:00:00Z',
      }),
    });
    // 4. POST /bots
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, botId: 'default', trustLevel: 1 }),
    });

    const result = await PayBotClient.signup('dev@example.com', 'password123');

    expect(result.operatorId).toBe('op_abc123');
    expect(result.apiKey).toBe('pb_live_abc123');
    expect(result.botId).toBe('default');
    expect(result.message).toContain('Save your API key');

    // Verify correct endpoints were called
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][0]).toContain('/auth/register');
    expect(mockFetch.mock.calls[1][0]).toContain('/auth/login');
    expect(mockFetch.mock.calls[2][0]).toContain('/api-keys');
    expect(mockFetch.mock.calls[3][0]).toContain('/bots');
  });

  it('should throw PayBotApiError on registration failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Email already registered', code: 'ALREADY_EXISTS' }),
    });

    await expect(PayBotClient.signup('existing@example.com', 'password'))
      .rejects.toThrow('Email already registered');
  });

  it('should use custom facilitatorUrl when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ operatorId: 'op_1', email: 'a@b.com', tier: 'free' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ accessToken: 'jwt', refreshToken: 'rt', expiresIn: 900, operator: { id: 'op_1', email: 'a@b.com', tier: 'free' } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'k1', key: 'pb_live_x', keyPrefix: 'pb_live_x', operatorId: 'op_1', permissions: 'all', rateLimit: 100, createdAt: '' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ success: true, botId: 'default', trustLevel: 1 }),
    });

    await PayBotClient.signup('a@b.com', 'pass', { facilitatorUrl: 'http://localhost:3000' });

    expect(mockFetch.mock.calls[0][0]).toContain('http://localhost:3000');
  });

  it('should throw on login failure after successful registration', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ operatorId: 'op_1', email: 'a@b.com', tier: 'free' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500,
      json: async () => ({ error: 'Internal server error', code: 'INTERNAL_ERROR' }),
    });

    await expect(PayBotClient.signup('a@b.com', 'pass'))
      .rejects.toThrow('Internal server error');
  });

  it('should use custom botId when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ operatorId: 'op_1', email: 'a@b.com', tier: 'free' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ accessToken: 'jwt', refreshToken: 'rt', expiresIn: 900, operator: { id: 'op_1', email: 'a@b.com', tier: 'free' } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'k1', key: 'pb_live_x', keyPrefix: 'pb_live_x', operatorId: 'op_1', permissions: 'all', rateLimit: 100, createdAt: '' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ success: true, botId: 'my-custom-bot', trustLevel: 1 }),
    });

    const result = await PayBotClient.signup('a@b.com', 'pass', { botId: 'my-custom-bot' });

    expect(result.botId).toBe('my-custom-bot');
    const botCallBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(botCallBody.botId).toBe('my-custom-bot');
  });
});

describe('PayBotClient.login()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return access and refresh tokens', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        accessToken: 'jwt_abc', refreshToken: 'rt_abc', expiresIn: 900, tokenType: 'Bearer',
        operator: { id: 'op_1', email: 'dev@test.com', tier: 'free', displayName: 'Dev' },
      }),
    });

    const result = await PayBotClient.login('dev@test.com', 'password');

    expect(result.accessToken).toBe('jwt_abc');
    expect(result.refreshToken).toBe('rt_abc');
    expect(result.expiresIn).toBe(900);
    expect(result.operator.email).toBe('dev@test.com');
    expect(result.operator.displayName).toBe('Dev');
  });

  it('should throw on invalid credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      json: async () => ({ error: 'Invalid email or password', code: 'AUTHENTICATION_FAILED' }),
    });

    await expect(PayBotClient.login('bad@email.com', 'wrong'))
      .rejects.toThrow('Invalid email or password');
  });

  it('should use custom facilitatorUrl', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        accessToken: 'jwt', refreshToken: 'rt', expiresIn: 900,
        operator: { id: 'op_1', email: 'a@b.com', tier: 'free' },
      }),
    });

    await PayBotClient.login('a@b.com', 'pass', { facilitatorUrl: 'http://localhost:3000' });

    expect(mockFetch.mock.calls[0][0]).toContain('http://localhost:3000');
  });
});

describe('API key management (instance methods)', () => {
  let client: InstanceType<typeof PayBotClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PayBotClient({
      apiKey: 'pb_live_test',
      botId: 'test-bot',
      facilitatorUrl: 'https://api.paybotcore.com',
    });
  });

  describe('client.createApiKey()', () => {
    it('should create a new API key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          id: 'key_new', key: 'pb_live_newkey', keyPrefix: 'pb_live_newk',
          operatorId: 'op_1', label: 'production', permissions: 'all',
          rateLimit: 100, createdAt: '2026-03-01T00:00:00Z',
        }),
      });

      const result = await client.createApiKey({ label: 'production', accessToken: 'jwt_test' });

      expect(result.key).toBe('pb_live_newkey');
      expect(result.label).toBe('production');
      expect(mockFetch.mock.calls[0][0]).toContain('/api-keys');
    });

    it('should throw on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 403,
        json: async () => ({ error: 'Forbidden', code: 'FORBIDDEN' }),
      });

      await expect(client.createApiKey({ accessToken: 'bad_jwt' }))
        .rejects.toThrow('Forbidden');
    });
  });

  describe('client.listApiKeys()', () => {
    it('should return list of API keys without raw keys', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ([
          { id: 'k1', keyPrefix: 'pb_live_ab', operatorId: 'op_1', label: 'dev', permissions: 'all', rateLimit: 100, active: true, createdAt: '', lastUsedAt: null },
          { id: 'k2', keyPrefix: 'pb_live_cd', operatorId: 'op_1', label: 'prod', permissions: 'all', rateLimit: 100, active: true, createdAt: '', lastUsedAt: null },
        ]),
      });

      const keys = await client.listApiKeys('jwt_test');

      expect(keys).toHaveLength(2);
      expect(keys[0].keyPrefix).toBe('pb_live_ab');
    });

    it('should throw on auth failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 401,
        json: async () => ({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
      });

      await expect(client.listApiKeys('expired_jwt'))
        .rejects.toThrow('Unauthorized');
    });
  });

  describe('client.revokeApiKey()', () => {
    it('should revoke an API key by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ success: true, keyId: 'k1', active: false }),
      });

      const result = await client.revokeApiKey('k1', 'jwt_test');

      expect(result.success).toBe(true);
      expect(result.active).toBe(false);
      expect(mockFetch.mock.calls[0][0]).toContain('/api-keys/k1');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });
});

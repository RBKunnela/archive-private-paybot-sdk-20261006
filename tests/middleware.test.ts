import { describe, it, expect, vi } from 'vitest';
import { paybot402 } from '../src/middleware.js';

// Minimal mock objects that satisfy IncomingMessage / ServerResponse shapes
function mockReq(paymentHeader?: string): {
  headers: Record<string, string | undefined>;
} {
  return {
    headers: paymentHeader !== undefined
      ? { 'x-payment-response': paymentHeader }
      : {},
  };
}

function mockRes(): {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

describe('paybot402 middleware', () => {
  const baseConfig = {
    payTo: '0xMerchantWallet',
    amount: '1000000', // $1.00 USDC
  };

  describe('without payment header — returns 402', () => {
    it('should return HTTP 402 when no x-payment-response header present', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      middleware(req as never, res as never, next);

      expect(res.writeHead).toHaveBeenCalledWith(402, expect.objectContaining({
        'Content-Type': 'application/json',
      }));
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
    });

    it('should include x402Version: 1 in the response body', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(body.x402Version).toBe(1);
    });

    it('should include correct accepts entry in response body', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{
          scheme: string;
          network: string;
          payTo: string;
          amount: string;
          maxTimeoutSeconds: number;
        }>;
      };

      expect(body.accepts).toHaveLength(1);
      const accept = body.accepts[0];
      expect(accept.scheme).toBe('exact');
      expect(accept.payTo).toBe('0xMerchantWallet');
      expect(accept.amount).toBe('1000000');
      expect(accept.maxTimeoutSeconds).toBe(300);
    });

    it('should default network to eip155:84532 (Base Sepolia)', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{ network: string; asset: string }>;
      };
      expect(body.accepts[0].network).toBe('eip155:84532');
      expect(body.accepts[0].asset).toContain('eip155:84532');
    });

    it('should use the USDC contract address for default network', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{ asset: string }>;
      };
      // Base Sepolia USDC
      expect(body.accepts[0].asset).toBe(
        'eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      );
    });

    it('should default facilitatorUrl to https://api.paybotcore.com', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        facilitatorUrl: string;
      };
      expect(body.facilitatorUrl).toBe('https://api.paybotcore.com');
    });

    it('should return 402 when x-payment-response header is empty string', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq('');
      const res = mockRes();
      const next = vi.fn();

      middleware(req as never, res as never, next);

      expect(res.writeHead).toHaveBeenCalledWith(402, expect.anything());
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('with payment header — calls next()', () => {
    it('should call next() when x-payment-response header is present', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq('some-payment-proof');
      const res = mockRes();
      const next = vi.fn();

      middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalledWith();
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('should call next() with any non-empty payment header value', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq('0xSomeTransactionHash');
      const res = mockRes();
      const next = vi.fn();

      middleware(req as never, res as never, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom configuration', () => {
    it('should use custom network when specified', () => {
      const middleware = paybot402({
        ...baseConfig,
        network: 'eip155:8453',
      });
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{ network: string; asset: string }>;
      };
      expect(body.accepts[0].network).toBe('eip155:8453');
      expect(body.accepts[0].asset).toContain('eip155:8453');
    });

    it('should use custom facilitatorUrl when specified', () => {
      const middleware = paybot402({
        ...baseConfig,
        facilitatorUrl: 'https://my-facilitator.example.com',
      });
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        facilitatorUrl: string;
      };
      expect(body.facilitatorUrl).toBe('https://my-facilitator.example.com');
    });

    it('should use custom asset when specified', () => {
      const customAsset = 'eip155:84532/erc20:0xCustomToken';
      const middleware = paybot402({
        ...baseConfig,
        asset: customAsset,
      });
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{ asset: string }>;
      };
      expect(body.accepts[0].asset).toBe(customAsset);
    });

    it('should use custom maxTimeoutSeconds when specified', () => {
      const middleware = paybot402({
        ...baseConfig,
        maxTimeoutSeconds: 600,
      });
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = JSON.parse(res.end.mock.calls[0][0] as string) as {
        accepts: Array<{ maxTimeoutSeconds: number }>;
      };
      expect(body.accepts[0].maxTimeoutSeconds).toBe(600);
    });

    it('should reuse same response body for all requests (cached)', () => {
      const middleware = paybot402(baseConfig);
      const next = vi.fn();

      // Call middleware twice
      const res1 = mockRes();
      middleware(mockReq() as never, res1 as never, next);
      const body1 = res1.end.mock.calls[0][0] as string;

      const res2 = mockRes();
      middleware(mockReq() as never, res2 as never, next);
      const body2 = res2.end.mock.calls[0][0] as string;

      // Should be the exact same string reference (pre-serialized)
      expect(body1).toBe(body2);
    });
  });

  describe('Content-Length header', () => {
    it('should include correct Content-Length in response', () => {
      const middleware = paybot402(baseConfig);
      const req = mockReq();
      const res = mockRes();

      middleware(req as never, res as never, vi.fn());

      const body = res.end.mock.calls[0][0] as string;
      const expectedLength = String(Buffer.byteLength(body));

      expect(res.writeHead).toHaveBeenCalledWith(402, expect.objectContaining({
        'Content-Length': expectedLength,
      }));
    });
  });
});

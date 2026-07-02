import { BadRequestException } from '@nestjs/common';
import {
  assertAllowedProviderBaseUrl,
  IsAllowedProviderBaseUrlConstraint,
  isAllowedProviderBaseUrl,
  validateProviderBaseUrl,
} from './provider-baseurl-guard';

/**
 * SSRF guard do baseUrl de providers. Cobre allowlist exata, https-only,
 * rejeição de IP interno/loopback/link-local e extensão por env.
 */

describe('provider baseUrl SSRF guard', () => {
  const ENV_KEY = 'AI_PROVIDER_ALLOWED_HOSTS';
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  describe('hosts allowlisted válidos → aceitos', () => {
    it.each([
      'https://api.openai.com/v1',
      'https://api.moonshot.ai/v1',
      'https://api.moonshot.cn/v1',
      'https://api.z.ai/api/paas/v4',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://openrouter.ai/api/v1',
    ])('%s', (url) => {
      expect(isAllowedProviderBaseUrl(url)).toBe(true);
    });

    it('é case-insensitive no hostname', () => {
      expect(isAllowedProviderBaseUrl('https://API.Z.AI/api/paas/v4')).toBe(true);
    });
  });

  describe('IPs internos / loopback / link-local → rejeitados', () => {
    it.each([
      'https://169.254.169.254/latest/meta-data/', // cloud metadata
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://192.168.1.1/v1',
      'https://172.16.0.1/v1',
      'https://172.31.255.255/v1',
      'https://100.64.0.1/v1', // CGNAT
      'https://0.0.0.0/v1',
      'https://localhost/v1',
      'https://[::1]/v1',
      'https://[fc00::1]/v1',
      'https://[fe80::1]/v1',
    ])('%s', (url) => {
      expect(isAllowedProviderBaseUrl(url)).toBe(false);
    });
  });

  describe('bypass por substring/endsWith → rejeitados', () => {
    it.each([
      'https://api.moonshot.ai.evil.com/v1',
      'https://xapi.z.ai/v1',
      'https://evilapi.moonshot.ai/v1',
      'https://api.z.ai.evil.com/v1',
    ])('%s', (url) => {
      expect(isAllowedProviderBaseUrl(url)).toBe(false);
    });
  });

  describe('outras rejeições', () => {
    it('host desconhecido (evil.com) → rejeitado', () => {
      expect(isAllowedProviderBaseUrl('https://evil.com/v1')).toBe(false);
    });

    it('http (não https) → rejeitado mesmo em host allowlisted', () => {
      const res = validateProviderBaseUrl('http://api.z.ai/api/paas/v4');
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/https/);
    });

    it('URL malformada → rejeitada', () => {
      expect(isAllowedProviderBaseUrl('not a url')).toBe(false);
    });
  });

  describe('extensão via env AI_PROVIDER_ALLOWED_HOSTS', () => {
    it('adiciona host custom (proxy self-hosted) à allowlist', () => {
      expect(isAllowedProviderBaseUrl('https://proxy.internal.example.com/v1')).toBe(false);
      process.env[ENV_KEY] = 'proxy.internal.example.com, another.host.example';
      expect(isAllowedProviderBaseUrl('https://proxy.internal.example.com/v1')).toBe(true);
      expect(isAllowedProviderBaseUrl('https://another.host.example/v1')).toBe(true);
    });

    it('IP interno adicionado via env AINDA é rejeitado (defesa extra)', () => {
      process.env[ENV_KEY] = '10.0.0.9';
      expect(isAllowedProviderBaseUrl('https://10.0.0.9/v1')).toBe(false);
    });

    it('localhost adicionado via env AINDA é rejeitado', () => {
      process.env[ENV_KEY] = 'localhost';
      expect(isAllowedProviderBaseUrl('https://localhost/v1')).toBe(false);
    });
  });

  describe('assertAllowedProviderBaseUrl', () => {
    it('lança BadRequestException em baseUrl inválido', () => {
      expect(() => assertAllowedProviderBaseUrl('https://169.254.169.254/')).toThrow(
        BadRequestException,
      );
    });

    it('não lança em baseUrl válido', () => {
      expect(() => assertAllowedProviderBaseUrl('https://api.z.ai/api/paas/v4')).not.toThrow();
    });
  });

  describe('class-validator constraint', () => {
    const c = new IsAllowedProviderBaseUrlConstraint();
    it('valida string allowlisted', () => {
      expect(c.validate('https://api.moonshot.ai/v1')).toBe(true);
    });
    it('rejeita não-string e host proibido', () => {
      expect(c.validate(123)).toBe(false);
      expect(c.validate('https://127.0.0.1/')).toBe(false);
    });
  });
});

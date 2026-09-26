import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../worker/auth';
import {
  contentDisposition,
  inlineImageType,
  parseCookies,
  readJsonObject,
} from '../../worker/http';
import { mediaPath } from '../../worker/lock';
import { rateLimitKey } from '../../worker/rate-limit';
import { imageBytesMatch } from '../../worker/storage';

describe('worker input hardening', () => {
  it('ignores malformed cookie encoding instead of throwing', () => {
    expect(parseCookies('good=ok; broken=%E0%A4%A')).toEqual({ good: 'ok', broken: '%E0%A4%A' });
  });

  it('parses only bounded JSON objects', async () => {
    const valid = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    await expect(readJsonObject(valid, 64)).resolves.toEqual({ ok: true });

    const malformed = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    await expect(readJsonObject(malformed)).rejects.toMatchObject({ status: 400 });

    const array = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    await expect(readJsonObject(array)).rejects.toMatchObject({ status: 400 });

    const oversized = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(80) }),
    });
    await expect(readJsonObject(oversized, 32)).rejects.toMatchObject({ status: 413 });
  });

  it('never renders SVG or arbitrary uploaded types inline', () => {
    expect(inlineImageType('mark.svg', 'image/svg+xml')).toBe('application/octet-stream');
    expect(inlineImageType('photo.jpg', 'application/octet-stream')).toBe('image/jpeg');
    expect(inlineImageType('photo.heic', 'image/heic')).toBe('image/heic');
  });

  it('builds safe non-ASCII content disposition values', () => {
    expect(() => contentDisposition('촬영본🏍️.jpg')).not.toThrow();
    expect(() => contentDisposition(`broken-\ud800.jpg`)).not.toThrow();
  });

  it('rejects unsupported or corrupt password hashes without throwing', async () => {
    const tooExpensive = 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    await expect(verifyPassword('guess', tooExpensive)).resolves.toBe(false);
    await expect(verifyPassword('guess', 'pbkdf2$100000$%%%$%%%')).resolves.toBe(false);
  });

  it('still verifies hashes created by the application', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false);
  });
});

describe('media validation and cache identity', () => {
  const bytes = (...values: number[]) => new Uint8Array(values).buffer;

  it('checks derivative magic bytes against the declared type', () => {
    expect(imageBytesMatch(bytes(0xff, 0xd8, 0xff, 0x00), 'image/jpeg')).toBe(true);
    expect(imageBytesMatch(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png')).toBe(true);
    expect(imageBytesMatch(bytes(0x3c, 0x68, 0x74, 0x6d, 0x6c), 'image/jpeg')).toBe(false);
  });

  it('puts the immutable edit revision in edited media URLs', () => {
    expect(mediaPath('et', 'photo', 'token', 'revision-2')).toBe(
      '/media/et/photo?t=token&v=revision-2',
    );
    expect(mediaPath('t', 'photo', 'token')).toBe('/media/t/photo?t=token');
  });

  it('hashes rate-limit identities without storing their raw values', async () => {
    const request = new Request('https://example.test', {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    const key = await rateLimitKey(request, 'login', 'Admin');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.9');
    await expect(rateLimitKey(request, 'login', 'admin')).resolves.toBe(key);
  });
});

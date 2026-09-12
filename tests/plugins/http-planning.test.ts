import { describe, expect, it } from 'vitest';
import {
  optionalInputString, requiredCredential, requiredInputString, trustedBaseUrl,
  trustedHttpHeaders, trustedHttpRequestPlan, trustedHttpResponsePlan,
} from '../../src/plugins/http-planning.js';
import { IntegrationProviderUnavailableError } from '../../src/plugins/integration-types.js';

describe('trusted HTTP request planning', () => {
  it('normalizes HTTPS and loopback bases and rejects credentials or nonlocal HTTP', () => {
    expect(trustedBaseUrl('https://Provider.Example/api').href).toBe('https://provider.example/api/');
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(trustedBaseUrl(`http://${host}:8080/api`).href).toBe(`http://${host}:8080/api/`);
    }
    for (const value of [
      'http://provider.example/api', 'https://user:secret@provider.example/api',
      'https://provider.example/api?query=value', 'https://provider.example/api#fragment',
    ]) {
      expect(() => trustedBaseUrl(value)).toThrow('credential-free HTTPS or loopback HTTP');
    }
  });

  it('creates a URL while preserving the base, query values, and duplicate parameter order', () => {
    const baseUrl = trustedBaseUrl('https://provider.example/api');
    const query = new URLSearchParams([['tag', 'second'], ['tag', 'third'], ['empty', '']]);
    const request = Object.freeze({ method: 'GET' as const, path: 'records?tag=first', query });
    const result = trustedHttpRequestPlan(baseUrl, request);

    expect(result.url.href).toBe('https://provider.example/api/records?tag=first&tag=second&tag=third&empty=');
    expect(result).not.toHaveProperty('body');
    expect(baseUrl.href).toBe('https://provider.example/api/');
    expect(query.toString()).toBe('tag=second&tag=third&empty=');
    result.url.searchParams.set('tag', 'changed');
    expect(trustedHttpRequestPlan(baseUrl, request).url.searchParams.getAll('tag')).toEqual(['first', 'second', 'third']);
  });

  it.each(['https://other.example/api/records', '//other.example/api/records', '../outside', '/api-evil/records', '%2e%2e/outside'])
    ('rejects an escaped request path %s', (path) => {
      expect(() => trustedHttpRequestPlan(trustedBaseUrl('https://provider.example/api/'), { method: 'GET', path }))
        .toThrow('escaped its trusted API base URL');
    });

  it.each([null, false, 0, ''])('preserves falsey JSON body %s', (json) => {
    expect(trustedHttpRequestPlan(trustedBaseUrl('https://provider.example/'), { method: 'POST', path: 'records', json }).body)
      .toBe(JSON.stringify(json));
  });

  it('retains empty form bodies and the existing distinction between form and JSON size limits', () => {
    const baseUrl = trustedBaseUrl('https://provider.example/');
    const form = new URLSearchParams();
    expect(trustedHttpRequestPlan(baseUrl, { method: 'POST', path: 'records', form }).body).toBe('');
    form.set('value', 'x'.repeat(256 * 1024));
    expect(trustedHttpRequestPlan(baseUrl, { method: 'POST', path: 'records', form }).body).toBe(form.toString());
    expect(() => trustedHttpRequestPlan(baseUrl, { method: 'POST', path: 'records', json: false, form }))
      .toThrow('cannot contain JSON and form bodies');
  });

  it('bounds JSON by its serialized UTF-8 size', () => {
    const baseUrl = trustedBaseUrl('https://provider.example/');
    const json = 'é'.repeat((256 * 1024 - 2) / 2);
    const plan = trustedHttpRequestPlan(baseUrl, { method: 'POST', path: 'records', json });
    expect(Buffer.byteLength(plan.body!)).toBe(256 * 1024);
    expect(() => trustedHttpRequestPlan(baseUrl, { method: 'POST', path: 'records', json: `${json}é` }))
      .toThrow('integration request is too large');
  });

  it('merges headers in the established order without changing caller-owned values', () => {
    const authorization = Object.freeze({ accept: 'auth-accept', authorization: 'Bearer token', 'content-type': 'auth-type' });
    const headers = Object.freeze({ authorization: 'request-token', 'x-request': '' });
    const result = trustedHttpHeaders({ method: 'POST', path: 'records', json: null, headers }, authorization);

    expect(result).toEqual({ accept: 'auth-accept', authorization: 'request-token', 'content-type': 'application/json', 'x-request': '' });
    result.authorization = 'changed';
    expect(headers.authorization).toBe('request-token');
    expect(authorization.authorization).toBe('Bearer token');
    expect(trustedHttpHeaders({ method: 'POST', path: 'records', form: new URLSearchParams(), headers: { 'content-type': 'custom' } }, authorization)['content-type'])
      .toBe('custom');
  });
});

describe('trusted HTTP response planning', () => {
  const success = { ok: true, status: 200 };

  it('distinguishes empty and non-JSON bodies from JSON values requiring validation', () => {
    expect(trustedHttpResponsePlan(success, '', 'Provider')).toEqual({ kind: 'empty', value: { ok: true } });
    expect(trustedHttpResponsePlan(success, 'plain text', 'Provider')).toEqual({ kind: 'text', value: { text: 'plain text' } });
    expect(trustedHttpResponsePlan(success, ' ', 'Provider')).toEqual({ kind: 'text', value: { text: ' ' } });
    expect(trustedHttpResponsePlan(success, '{"text":"valid JSON"}', 'Provider'))
      .toEqual({ kind: 'json', value: { text: 'valid JSON' } });
  });

  it.each([null, false, 0, ''])('retains falsey JSON response %s', (value) => {
    expect(trustedHttpResponsePlan(success, JSON.stringify(value), 'Provider')).toEqual({ kind: 'json', value });
  });

  it('classifies HTTP errors before parsing response bodies', () => {
    for (const status of [429, 500, 503]) {
      expect(() => trustedHttpResponsePlan({ ok: false, status }, 'private detail', 'Provider'))
        .toThrow(IntegrationProviderUnavailableError);
    }
    for (const status of [400, 401, 403]) {
      expect(() => trustedHttpResponsePlan({ ok: false, status }, '', 'Provider')).toThrow(`Provider returned HTTP ${status}`);
    }
  });

  it('enforces the serialized JSON response bound after parsing', () => {
    const text = JSON.stringify('x'.repeat(256 * 1024 - 2));
    expect(trustedHttpResponsePlan(success, text, 'Provider').kind).toBe('json');
    expect(() => trustedHttpResponsePlan(success, JSON.stringify('x'.repeat(256 * 1024)), 'Provider'))
      .toThrow('integration response is too large');
  });
});

describe('HTTP input and credential values', () => {
  it('selects the first nonempty credential without modifying or exposing alternatives in failures', () => {
    const credential = Object.freeze({ first: '', second: 'token', third: 'fallback' });
    expect(requiredCredential(credential, 'first', 'second', 'third')).toBe('token');
    expect(() => requiredCredential(credential, 'missing', 'first')).toThrow('integration credential requires missing or first');
  });

  it('distinguishes optional absence from invalid falsey input and measures strings in UTF-8 bytes', () => {
    for (const value of [null, '']) expect(optionalInputString({ key: value }, 'key')).toBeUndefined();
    expect(optionalInputString({}, 'key')).toBeUndefined();
    for (const value of [false, 0]) {
      expect(() => optionalInputString({ key: value }, 'key')).toThrow('must be a bounded string');
      expect(() => requiredInputString({ key: value }, 'key')).toThrow('must be a bounded non-empty string');
    }
    expect(requiredInputString({ key: 'é' }, 'key', 2)).toBe('é');
    expect(() => requiredInputString({ key: 'é' }, 'key', 1)).toThrow('bounded non-empty string');
    expect(optionalInputString({ key: ' ' }, 'key', 1)).toBe(' ');
    expect(() => optionalInputString({ key: 'é' }, 'key', 1)).toThrow('bounded string');
  });
});

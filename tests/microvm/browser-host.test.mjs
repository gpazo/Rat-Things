import { describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  validateBrowserArtifactPath,
} from '../../microvm/browser-host.mjs';

describe('MicroVM browser destination policy', () => {
  it('accepts ordinary public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('blocks private, link-local, documentation, benchmark, and multicast ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
    ]) expect(isPublicAddress(address), address).toBe(false);
  });

  it('accepts nested artifact paths and rejects traversal or ambiguous segments', () => {
    expect(() => validateBrowserArtifactPath('browser/navigation/final.jpg')).not.toThrow();
    for (const path of [
      '',
      '/absolute.jpg',
      '../outside.jpg',
      'browser/../outside.jpg',
      'browser//frame.jpg',
      'browser\\frame.jpg',
      'browser/line\nfeed.jpg',
    ]) expect(() => validateBrowserArtifactPath(path), path).toThrow(
      'browser artifact path is invalid',
    );
  });
});

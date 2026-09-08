import { describe, expect, it, vi } from 'vitest';
import { checkPublicationDns } from '../../scripts/check-publication-dns.js';

const zone = {
  HostedZone: { Name: 'content.example.', Config: { PrivateZone: false } },
  DelegationSet: { NameServers: ['ns-1.awsdns.example', 'ns-2.awsdns.example'] },
};

describe('publication DNS preflight', () => {
  it('accepts public delegation regardless of ordering, case, or trailing dots', async () => {
    const resolve = vi.fn().mockResolvedValue(['NS-2.AWSDNS.EXAMPLE.', 'ns-1.awsdns.example.']);
    await expect(checkPublicationDns('test.content.example', zone, resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith('content.example');
  });

  it('rejects a zone that exists in AWS but is not delegated publicly', async () => {
    await expect(checkPublicationDns('test.content.example', zone, async () => ['ns.other-provider.example']))
      .rejects.toThrow('not authoritative in public DNS');
  });

  it('rejects private zones and domains outside the selected zone before resolving DNS', async () => {
    const resolve = vi.fn();
    await expect(checkPublicationDns('content.example', {
      ...zone, HostedZone: { ...zone.HostedZone, Config: { PrivateZone: true } },
    }, resolve)).rejects.toThrow('public Route 53 zone');
    for (const domain of ['other.example', 'notcontent.example']) {
      await expect(checkPublicationDns(domain, zone, resolve)).rejects.toThrow('outside Route 53 zone');
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

import { execFileSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

interface HostedZone {
  HostedZone: { Name: string; Config?: { PrivateZone?: boolean } };
  DelegationSet?: { NameServers?: string[] };
}

/** Check public DNS before creating a stack that waits for ACM validation. */
export async function checkPublicationDns(
  domain: string,
  zone: HostedZone,
  resolveNameservers = (name: string) => new Resolver({ timeout: 5_000, tries: 2 }).resolveNs(name),
): Promise<void> {
  const zoneName = dnsName(zone.HostedZone.Name);
  const publicationName = dnsName(domain);
  if (zone.HostedZone.Config?.PrivateZone) throw new Error('publication delivery requires a public Route 53 zone');
  if (publicationName !== zoneName && !publicationName.endsWith(`.${zoneName}`)) {
    throw new Error(`publication domain ${domain} is outside Route 53 zone ${zoneName}`);
  }
  const expected = (zone.DelegationSet?.NameServers ?? []).map(dnsName).sort();
  const actual = (await resolveNameservers(zoneName)).map(dnsName).sort();
  if (expected.length === 0 || expected.join(',') !== actual.join(',')) {
    throw new Error(
      `Route 53 zone ${zoneName} is not authoritative in public DNS. ` +
      'Choose the authoritative hosted zone or delegate this zone before deploying publication delivery.',
    );
  }
}

function dnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , domain, zoneId] = process.argv;
    if (!domain || !zoneId) throw new Error('usage: check-publication-dns.ts DOMAIN HOSTED_ZONE_ID');
    const zone = JSON.parse(execFileSync('aws', [
      'route53', 'get-hosted-zone', '--id', zoneId, '--output', 'json',
    ], { encoding: 'utf8', timeout: 15_000 })) as HostedZone;
    await checkPublicationDns(domain, zone);
    process.stdout.write(`Publication DNS verified for ${domain}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

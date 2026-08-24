import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AWS-ready golden-path documentation', () => {
  it('states the measured boundary and proves a published active revision', async () => {
    const [guide, homepage, packageJson] = await Promise.all([
      readFile('docs/quickstart.md', 'utf8'),
      readFile('site/index.html', 'utf8'),
      readFile('package.json', 'utf8'),
    ]);

    expect(guide).toContain('# AWS-ready ten-minute quickstart');
    expect(guide).toContain('can take longer than ten minutes');
    expect(guide).toContain('invokes the published active revision');
    expect(guide).toContain('"activeRevision": 1');
    expect(guide).toContain('"invocation": "manual"');
    expect(guide).toContain('[latest AWS quickstart evidence](aws-quickstart-evidence.json)');

    expect(homepage).toContain('One narrow path. One active Thing.');
    expect(homepage).toContain('Installing host tools and arranging AWS service, quota, and Bedrock access');
    expect(homepage).not.toContain('One command. One real Thing.');

    expect(JSON.parse(packageJson).scripts['quickstart:aws']).toBe('./scripts/aws-quickstart.sh');
  });
});

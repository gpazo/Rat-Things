import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AWS-ready golden-path documentation', () => {
  it('states the measured boundary and proves a published active revision', async () => {
    const [guide, homepage, packageJson, evidenceJson] = await Promise.all([
      readFile('docs/quickstart.md', 'utf8'),
      readFile('site/index.html', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('docs/aws-quickstart-evidence.json', 'utf8'),
    ]);

    expect(guide).toContain('# AWS-ready ten-minute quickstart');
    expect(guide).toMatch(/can take longer\s+than ten minutes/);
    expect(guide).toContain('`us-east-1`, `us-east-2`, or `us-west-2`');
    expect(guide).toContain('creates, updates, and deletes no AWS resources');
    expect(guide).not.toContain('cost well below $1');
    expect(guide).toContain('invokes the published active revision');
    expect(guide).toContain('"activeRevision": 1');
    expect(guide).toContain('"terraformManagedResourceCount": 158');
    expect(guide).toContain('"invocation": "manual"');
    expect(guide).toContain('[latest AWS quickstart evidence](aws-quickstart-evidence.json)');

    expect(homepage).toContain('One narrow path. One active Thing.');
    expect(homepage).toContain('Installing host tools and arranging AWS service, quota, and Bedrock access');
    expect(homepage).toContain('Latest recorded live validation:');
    expect(homepage).not.toContain('Auditable proof:');
    expect(homepage).not.toContain('One command. One real Thing.');

    expect(JSON.parse(packageJson).scripts['quickstart:aws']).toBe('./scripts/aws-quickstart.sh');
    expect(JSON.parse(evidenceJson)).toMatchObject({
      status: 'passed',
      source: { commit: '7ff0bbfa183f2b85e063ff5e5c27d839e07cc85a', clean: true },
      environment: { terraformManagedResourceCount: 158 },
      measurement: { elapsedSeconds: 508, underTenMinutes: true },
      thing: { status: 'active', hasUnpublishedChanges: false },
      runs: {
        draftTest: { status: 'succeeded', invocation: 'test' },
        active: { status: 'succeeded', invocation: 'manual' },
      },
      teardown: { terraformStateEntries: 0, activeMicrovms: 0 },
    });
  });
});

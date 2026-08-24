import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AWS-ready golden-path documentation', () => {
  it('states the measured boundary and proves a published active revision', async () => {
    const [guide, homepage, costs, packageJson, evidenceJson] = await Promise.all([
      readFile('docs/quickstart.md', 'utf8'),
      readFile('site/index.html', 'utf8'),
      readFile('docs/costs.md', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('docs/aws-quickstart-evidence.json', 'utf8'),
    ]);

    expect(guide).toContain('# AWS-ready ten-minute quickstart');
    expect(guide).toMatch(/can take longer\s+than ten minutes/);
    expect(guide).toContain('`us-east-1`, `us-east-2`, or `us-west-2`');
    expect(guide).toContain('golden-path-v1');
    expect(guide).toContain('automatically reuse');
    expect(guide).toContain('creates, updates, and deletes no AWS resources');
    expect(guide).not.toContain('cost well below $1');
    expect(guide).toContain('invokes the published active revision');
    expect(guide).toContain('"activeRevision": 1');
    expect(guide).toContain('"terraformManagedResourceCount": 158');
    expect(guide).toContain('"invocation": "manual"');
    expect(guide).toContain('[latest AWS quickstart evidence](aws-quickstart-evidence.json)');

    expect(homepage).toContain('One narrow path. One active Thing.');
    expect(homepage).toContain('--branch golden-path-v1');
    expect(homepage).toContain('intentionally a readiness canary');
    expect(homepage).toContain('Installing host tools and arranging AWS service, quota, and Bedrock access');
    expect(homepage).toContain('Latest recorded live validation:');
    expect(homepage).toContain('476 seconds (7m56s)');
    expect(homepage).not.toContain('Auditable proof:');
    expect(homepage).not.toContain('One command. One real Thing.');

    expect(costs).toContain('$0.380 total is a historical estimate');
    expect(costs).toContain('| Short, up to 272K | $2.20 | $2.75 | $0.22 | $13.20 |');
    expect(costs).toContain('there is no monthly key charge while a customer-managed key is scheduled for deletion');
    expect(costs).not.toContain('The current public-list estimate');

    expect(JSON.parse(packageJson).scripts['quickstart:aws']).toBe('./scripts/aws-quickstart.sh');
    expect(JSON.parse(evidenceJson)).toMatchObject({
      status: 'passed',
      source: {
        cloneRef: 'golden-path-v1',
        commit: 'c6752b816dbc78952a05907daf95e39ceb9edf6c',
        clean: true,
      },
      host: { platform: 'darwin', architecture: 'arm64' },
      environment: { terraformManagedResourceCount: 158 },
      measurement: {
        elapsedMilliseconds: 475708,
        elapsedSeconds: 476,
        elapsedSecondsRounding: 'ceiling to whole seconds',
        underTenMinutes: true,
      },
      thing: { status: 'active', hasUnpublishedChanges: false },
      runs: {
        draftTest: { status: 'succeeded', invocation: 'test' },
        active: { status: 'succeeded', invocation: 'manual' },
      },
      teardown: { terraformStateEntries: 0, activeMicrovms: 0 },
      independentPostcheck: {
        destroyedStateManagedInstances: 0,
        exactMicrovmImage: { activeMicrovms: 0 },
        exactKmsKey: { enabled: false, state: 'PendingDeletion' },
      },
    });
  });
});

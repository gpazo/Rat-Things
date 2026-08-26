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
    expect(guide).toContain('golden-path-v1.0.0');
    expect(guide).toContain('requires Bash');
    expect(guide).toContain('Linux, including WSL 2');
    expect(guide).toContain('automatically reuse');
    expect(guide).toContain('creates, updates, and deletes no AWS resources');
    expect(guide).not.toContain('cost well below $1');
    expect(guide).toContain('invokes the published active revision');
    expect(guide).toContain('"activeRevision": 1');
    expect(guide).toContain('"terraformManagedResourceCount": 158');
    expect(guide).toContain('"invocation": "manual"');
    expect(guide).toContain('[centrally published AWS quickstart evidence]');
    expect(guide).toContain('An immutable source tag cannot contain evidence produced after that same commit exists.');

    expect(homepage).toContain('Deploy, test, then decide.');
    expect(homepage).toContain('--branch golden-path-v1.0.0');
    expect(homepage).toContain('Start with the smallest proof. Add accounts and capabilities after it is dependable.');
    expect(homepage).toContain('Host tools, AWS quota, Lambda MicroVM access, and Bedrock access must already be ready.');
    expect(homepage).toContain('Published proof:');
    expect(homepage).toContain('402 seconds (6m42s)');
    expect(homepage).toContain('S3 Files, hosted OAuth, schedules, and external sharing stay outside this first journey.');

    expect(costs).toContain('$0.380 total is a historical estimate');
    expect(costs).toContain('| Short, up to 272K | $2.20 | $2.75 | $0.22 | $13.20 |');
    expect(costs).toContain('there is no monthly key charge while a customer-managed key is scheduled for deletion');
    expect(costs).not.toContain('The current public-list estimate');

    expect(JSON.parse(packageJson).scripts['quickstart:aws']).toBe('./scripts/aws-quickstart.sh');
    expect(JSON.parse(evidenceJson)).toMatchObject({
      status: 'passed',
      source: {
        cloneRef: 'golden-path-v1.0.0',
        commit: 'f1c5487f1eb0c1bbf778a75fea939f4474ee68ff',
        clean: true,
      },
      host: { platform: 'darwin', architecture: 'arm64' },
      environment: { terraformManagedResourceCount: 158 },
      measurement: {
        elapsedMilliseconds: 401106,
        elapsedSeconds: 402,
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

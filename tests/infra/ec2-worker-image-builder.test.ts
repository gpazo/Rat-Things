import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('prepared worker image pipeline', () => {
  it('cannot start an image build during Terraform apply', async () => {
    const source = await readFile(join(process.cwd(), 'infra/modules/agent-runner/ec2-worker-image-builder.tf'), 'utf8');
    expect(source).not.toMatch(/resource\s+"aws_imagebuilder_image"/);
    expect(source).not.toMatch(/^\s*schedule\s*\{/m);
  });
});

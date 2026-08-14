import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  githubTerraformConfig,
  parseGitHubOnboardingOptions,
} from '../../scripts/onboard-github.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GitHub webhook onboarding', () => {
  it('uses safe smoke-test defaults', () => {
    vi.stubEnv('AWS_REGION', '');
    vi.stubEnv('AWS_DEFAULT_REGION', '');
    const options = parseGitHubOnboardingOptions(['setup', '--repo', 'owner/project']);
    expect(options).toMatchObject({
      command: 'setup',
      repo: 'owner/project',
      region: 'us-west-2',
      environment: 'dev',
      trigger: '@rat-things',
      driver: 'mock',
      yes: false,
      dryRun: false,
    });
  });

  it('rejects unsafe or ambiguous setup values', () => {
    expect(() => parseGitHubOnboardingOptions(['setup'])).toThrow('--repo OWNER/REPOSITORY is required');
    expect(() => parseGitHubOnboardingOptions(['setup', '--repo', 'https://github.com/o/r'])).toThrow(
      '--repo must use the OWNER/REPOSITORY form',
    );
    expect(() => parseGitHubOnboardingOptions(['setup', '--repo', 'o/r', '--driver', 'auto'])).toThrow(
      '--driver must be mock or codex',
    );
  });

  it('writes only secret references into Terraform configuration', () => {
    const options = parseGitHubOnboardingOptions([
      'setup',
      '--repo',
      'owner/project',
      '--driver',
      'codex',
      '--profile',
      'sandbox',
    ]);
    const config = githubTerraformConfig(options, {
      webhook: 'arn:webhook',
      clone: 'arn:clone',
      notify: 'arn:notify',
    }, '7');
    expect(config).toEqual(expect.objectContaining({
      aws_profile: 'sandbox',
      default_agent_driver: 'codex',
      github_webhook_secret_arn: 'arn:webhook',
      github_clone_token_secret_arn: 'arn:clone',
      github_notify_token_secret_arn: 'arn:notify',
      enable_s3_files: false,
      microvm_base_image_version: '7',
    }));
    expect(JSON.stringify(config)).not.toContain('secret-string');
  });
});

import { describe, expect, it } from 'vitest';
import {
  awsQuickstartTerraformConfig,
  awsQuickstartThing,
  parseAwsQuickstartOptions,
} from '../../scripts/aws-quickstart.js';

describe('AWS quickstart', () => {
  it('defaults to a real, narrow Codex deployment', () => {
    const options = parseAwsQuickstartOptions([]);
    expect(options).toMatchObject({
      command: 'setup',
      driver: 'codex',
      region: 'us-west-2',
      environment: 'quickstart',
      model: 'openai.gpt-5.6-terra',
    });
    expect(awsQuickstartTerraformConfig(options, '7')).toMatchObject({
      default_agent_driver: 'codex',
      default_sandbox_mode: 'read-only',
      default_agent_network_access: false,
      enable_s3_files: false,
      microvm_base_image_version: '7',
      force_destroy_data: true,
    });
  });

  it('makes mock mode explicit and generates one safe manual Thing', () => {
    const options = parseAwsQuickstartOptions(['--driver', 'mock', '--yes']);
    expect(options).toMatchObject({ driver: 'mock', yes: true });
    expect(awsQuickstartThing('mock', 'RAT-THINGS-READY-TEST')).toMatchObject({
      trigger: { kind: 'manual' },
      agent: {
        driver: 'mock',
        sandbox: 'read-only',
        capabilities: {
          networkAccess: false,
          webSearch: 'disabled',
          computerUse: 'disabled',
        },
      },
      deliver: [{ kind: 'none' }],
    });
  });

  it('rejects ambiguous and unsupported setup choices before AWS changes', () => {
    expect(() => parseAwsQuickstartOptions(['--driver', 'auto'])).toThrow('--driver must be codex or mock');
    expect(() => parseAwsQuickstartOptions(['--region', 'eu-central-1'])).toThrow(
      'Lambda MicroVM quickstart is not supported',
    );
    expect(() => parseAwsQuickstartOptions(['--unknown', 'value'])).toThrow('unknown option');
  });
});

import { createHash } from 'node:crypto';
import type { RunRecord, RunRequest } from '../domain/contracts.js';
import { executionGeneration } from '../execution/generation.js';
import type { MicrovmStartupObservation } from './executors.js';

export interface MicrovmExecutorOptions {
  imageParameterName: string;
  imageVersionParameterName: string;
  executionRoleArn: string;
  logGroupName: string;
  runsTableName: string;
  integrationsTableName: string;
  agentsTableName?: string;
  definitionBucket?: string;
  credentialNamePrefix?: string;
  credentialKmsKeyArn?: string;
  artifactBucket: string;
  eventBusName: string;
  region: string;
  allowedRepositoryHosts: string;
  allowedSandboxModes: string;
  defaultSandboxMode?: string;
  defaultAgentNetworkAccess?: boolean;
  defaultModel?: string;
  codexAuthFileSecretArn?: string;
  bedrockApiKeySecretArn?: string;
  allowAgentAwsCredentialChain: boolean;
  sessionIdleSeconds?: number;
  sessionSuspendedSeconds?: number;
  heartbeatIntervalMs?: number;
  onStartupObservation?: (observation: MicrovmStartupObservation) => void;
  s3Files?: {
    networkConnectorArn?: string;
    fileSystemId: string;
    accessPointId: string;
    mountTargetIp: string;
  };
}

export function runHookPayload(record: RunRecord, request: RunRequest, options: MicrovmExecutorOptions): string {
    const payload = JSON.stringify({
      version: 1,
      runId: record.runId,
      executionGeneration: record.execution?.generation ?? executionGeneration(record),
      inputBucket: record.input.bucket,
      inputKey: record.input.key,
      runsTableName: options.runsTableName,
      integrationsTableName: options.integrationsTableName,
      ...(record.agentsSession ? {
        agentsTableName: options.agentsTableName, definitionBucket: options.definitionBucket,
        credentialNamePrefix: options.credentialNamePrefix, credentialKmsKeyArn: options.credentialKmsKeyArn,
      } : {}),
      artifactBucket: options.artifactBucket,
      eventBusName: options.eventBusName,
      region: options.region,
      timeoutSeconds: request.execution?.timeoutSeconds ?? 900,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      // RunMicrovm client tokens are limited to printable ASCII and 64 characters.
      traceId: record.runId,
      allowedRepositoryHosts: options.allowedRepositoryHosts,
      allowedSandboxModes: options.allowedSandboxModes,
      defaultSandboxMode: options.defaultSandboxMode ?? 'danger-full-access',
      defaultAgentNetworkAccess: options.defaultAgentNetworkAccess ?? true,
      persistentSession: Boolean(record.agentsSession),
      ...((record.agentsSession) && options.s3Files ? {
        sessionStorageKey: createHash('sha256')
          .update(JSON.stringify([record.ownerId, record.agentsSession.sessionId]))
          .digest('hex'),
        s3FilesFileSystemId: options.s3Files.fileSystemId,
        s3FilesAccessPointId: options.s3Files.accessPointId,
        s3FilesMountTargetIp: options.s3Files.mountTargetIp,
      } : {}),
      ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
      ...(options.codexAuthFileSecretArn
        ? { codexAuthFileSecretArn: options.codexAuthFileSecretArn }
        : {}),
      ...(options.bedrockApiKeySecretArn
        ? { bedrockApiKeySecretArn: options.bedrockApiKeySecretArn }
        : {}),
      allowAgentAwsCredentialChain: options.allowAgentAwsCredentialChain,
    });
    if (Buffer.byteLength(payload) > 4_096) {
      throw new Error('Lambda MicroVM run hook payload exceeds 4096 bytes');
    }
    return payload;
}

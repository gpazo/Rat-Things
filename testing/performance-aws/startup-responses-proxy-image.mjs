#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { STARTUP_RESPONSES_PROXY } from './startup-responses-proxy.mjs';

const [sourceArgument, outputArgument, modeFlag, mode] = process.argv.slice(2);
if (process.argv.length !== 6 || !sourceArgument || !outputArgument || modeFlag !== '--mode' || !['fixture', 'bedrock'].includes(mode)) {
  throw new Error('usage: node startup-responses-proxy-image.mjs <sourceZIP> <outputZIP> --mode fixture|bedrock');
}

const sourceZip = realpathSync(resolve(sourceArgument));
const outputZip = resolve(outputArgument);
if (sourceZip === (existsSync(outputZip) ? realpathSync(outputZip) : outputZip)) throw new Error('sourceZIP and outputZIP must be different files');
const outputDirectory = dirname(outputZip);
if (!existsSync(outputDirectory)) mkdirSync(outputDirectory, { recursive: true });
const workDirectory = mkdtempSync(join(outputDirectory, '.startup-responses-proxy-image-'));
const contextDirectory = join(workDirectory, 'context');
const outputTempZip = join(workDirectory, 'overlay-source.zip');
const changedEntries = new Set(['Dockerfile', 'runtime-server.mjs', 'config/codex.toml']);
const addedEntries = ['startup-responses-proxy.mjs', 'startup-responses-proxy-manifest.json'];

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: contextDirectory,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'signal'}): ${(result.stderr ?? '').slice(-2000)}`);
  return result.stdout ?? '';
};

const replaceUnique = (source, original, replacement, label) => {
  const matches = source.split(original).length - 1;
  if (matches !== 1) throw new Error(`expected one ${label} replacement point, found ${matches}`);
  return source.replace(original, replacement);
};
const readModeAndCrc = (archive, name) => {
  const details = run('unzip', ['-Z', '-v', archive, name]);
  const modeMatch = details.match(/Unix file attributes \(([0-7]+) octal\):/);
  const crcMatch = details.match(/32-bit CRC value \(hex\):\s*([a-f0-9]{8})/i);
  if (!modeMatch || !crcMatch) throw new Error(`could not inspect ZIP metadata for ${name}`);
  const mode = Number.parseInt(modeMatch[1], 8);
  if ((mode & 0o170000) === 0o120000) throw new Error(`sourceZIP contains a symlink entry ${name}`);
  return { mode: mode & 0o777, crc: crcMatch[1].toLowerCase() };
};

const sha256 = (input) => createHash('sha256').update(input).digest('hex');

try {
  mkdirSync(contextDirectory);
  const names = run('unzip', ['-Z1', sourceZip]).split(/\r?\n/).filter(Boolean);
  const counts = new Map();
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').some((part) => part === '..')) throw new Error('sourceZIP contains an unsafe archive path');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count !== 1)) throw new Error('sourceZIP contains duplicate archive entries');
  for (const name of ['Dockerfile', 'runtime-server.mjs', 'config/codex.toml']) {
    if (counts.get(name) !== 1) throw new Error(`expected one ${name} entry in sourceZIP`);
  }
  if (addedEntries.some((name) => counts.has(name))) throw new Error('sourceZIP already contains a startup Responses proxy overlay');

  run('unzip', ['-q', '-o', sourceZip, 'Dockerfile', 'runtime-server.mjs', 'config/codex.toml', '-d', contextDirectory]);
  const runtimePath = join(contextDirectory, 'runtime-server.mjs');
  const dockerfilePath = join(contextDirectory, 'Dockerfile');
  const configPath = join(contextDirectory, 'config/codex.toml');
  const runtimeMode = statSync(runtimePath).mode & 0o777;
  const dockerfileMode = statSync(dockerfilePath).mode & 0o777;
  const configMode = statSync(configPath).mode & 0o777;
  const runtimeContents = readFileSync(runtimePath, 'utf8');
  const dockerfileContents = readFileSync(dockerfilePath, 'utf8');
  const configContents = readFileSync(configPath, 'utf8');
  if (configContents.includes('[model_providers.amazon-bedrock]') || configContents.includes('startup-responses-proxy')) {
    throw new Error('source config already contains a Responses proxy override');
  }

  const proxyContents = readFileSync(new URL('./startup-responses-proxy.mjs', import.meta.url));
  const manifest = {
    schema: 'rat-things.startup-responses-proxy.v1',
    mode,
    listenHost: STARTUP_RESPONSES_PROXY.host,
    listenPort: STARTUP_RESPONSES_PROXY.port,
    endpointPath: STARTUP_RESPONSES_PROXY.endpointPath,
    providerBaseUrl: STARTUP_RESPONSES_PROXY.providerBaseUrl,
    forwardURL: mode === 'bedrock' ? STARTUP_RESPONSES_PROXY.forwardUrl : null,
    model: STARTUP_RESPONSES_PROXY.model,
    limits: {
      requestsPerVm: STARTUP_RESPONSES_PROXY.requestLimit,
      requestBytes: STARTUP_RESPONSES_PROXY.requestBytesLimit,
      maxOutputTokens: STARTUP_RESPONSES_PROXY.outputTokensLimit,
      forwardTimeoutMs: STARTUP_RESPONSES_PROXY.forwardTimeoutMs,
      responseBytes: STARTUP_RESPONSES_PROXY.responseBytesLimit,
      requestMaxRetries: null,
      streamMaxRetries: null,
    },
    proxyRetries: STARTUP_RESPONSES_PROXY.proxyRetries,
    requestPolicy: { tools: 'forced_empty', toolChoice: 'none' },
    responsePolicy: 'message_or_reasoning_items_only',
    nativeRetryConfiguration: 'built_in_amazon_bedrock_override_rejected',
    proxySha256: sha256(proxyContents),
  };
  const manifestContents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

  let patchedRuntime = `import { startStartupResponsesProxy } from './startup-responses-proxy.mjs';\n${runtimeContents}`;
  patchedRuntime = replaceUnique(patchedRuntime,
    'server.listen(8080, process.env.DEFAULT_EXECUTION_BACKEND === \'ec2\' ? \'127.0.0.1\' : \'0.0.0.0\', () => {',
    `await startStartupResponsesProxy({ mode: '${mode}' });\n\nserver.listen(8080, process.env.DEFAULT_EXECUTION_BACKEND === 'ec2' ? '127.0.0.1' : '0.0.0.0', () => {`,
    'explicit test proxy startup');

  let patchedDockerfile = dockerfileContents;
  patchedDockerfile = replaceUnique(patchedDockerfile,
    'COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs\n',
    'COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs\nCOPY startup-responses-proxy.mjs /opt/agent-runtime/startup-responses-proxy.mjs\nCOPY startup-responses-proxy-manifest.json /opt/agent-runtime/startup-responses-proxy-manifest.json\n',
    'proxy module and manifest COPY');
  patchedDockerfile = replaceUnique(patchedDockerfile,
    '      /opt/agent-runtime/config/codex.toml \\\n',
    '      /opt/agent-runtime/startup-responses-proxy.mjs \\\n      /opt/agent-runtime/startup-responses-proxy-manifest.json \\\n      /opt/agent-runtime/config/codex.toml \\\n',
    'proxy root ownership');
  const chmodMarker = '    && chmod 0555 \\\n';
  const chownMarker = '\n    && chown -R agent:agent';
  const chmodStart = patchedDockerfile.indexOf(chmodMarker);
  const chownStart = patchedDockerfile.indexOf(chownMarker, chmodStart);
  if (chmodStart < 0 || chownStart < 0 || patchedDockerfile.indexOf(chmodMarker, chmodStart + 1) !== -1) {
    throw new Error('could not isolate the worker executable mode list');
  }
  const executableList = patchedDockerfile.slice(chmodStart + chmodMarker.length, chownStart);
  const patchedExecutableList = replaceUnique(executableList,
    '      /opt/agent-runtime/runtime-server.mjs \\\n',
    '      /opt/agent-runtime/runtime-server.mjs \\\n      /opt/agent-runtime/startup-responses-proxy.mjs \\\n',
    'proxy executable mode');
  patchedDockerfile = patchedDockerfile.slice(0, chmodStart + chmodMarker.length) + patchedExecutableList + patchedDockerfile.slice(chownStart);

  const patchedConfig = `${configContents.trimEnd()}\n\n[model_providers.amazon-bedrock]\nbase_url = "${STARTUP_RESPONSES_PROXY.providerBaseUrl}"\n`;
  writeFileSync(runtimePath, patchedRuntime, { mode: runtimeMode });
  chmodSync(runtimePath, runtimeMode);
  writeFileSync(dockerfilePath, patchedDockerfile, { mode: dockerfileMode });
  chmodSync(dockerfilePath, dockerfileMode);
  writeFileSync(configPath, patchedConfig, { mode: configMode });
  chmodSync(configPath, configMode);
  for (const [name, contents, fileMode] of [
    ['startup-responses-proxy.mjs', proxyContents, 0o444],
    ['startup-responses-proxy-manifest.json', manifestContents, 0o444],
  ]) {
    const path = join(contextDirectory, name);
    writeFileSync(path, contents, { mode: fileMode });
    chmodSync(path, fileMode);
  }

  copyFileSync(sourceZip, outputTempZip);
  const zipResult = spawnSync('zip', ['-q', '-u', outputTempZip, 'Dockerfile', 'runtime-server.mjs', 'config/codex.toml', ...addedEntries], {
    cwd: contextDirectory,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  if (zipResult.error) throw zipResult.error;
  if (zipResult.status !== 0) throw new Error(`zip update failed (${zipResult.status ?? 'signal'}): ${(zipResult.stderr ?? '').slice(-2000)}`);

  const outputNames = run('unzip', ['-Z1', outputTempZip]).split(/\r?\n/).filter(Boolean);
  const outputCounts = new Map();
  for (const name of outputNames) outputCounts.set(name, (outputCounts.get(name) ?? 0) + 1);
  for (const [name, count] of counts) if (outputCounts.get(name) !== count) throw new Error(`overlay changed sourceZIP entry count for ${name}`);
  if (outputCounts.size !== counts.size + addedEntries.length || addedEntries.some((name) => outputCounts.get(name) !== 1)) {
    throw new Error('overlay must add only its proxy module and manifest');
  }

  for (const name of names) {
    const before = readModeAndCrc(sourceZip, name);
    const after = readModeAndCrc(outputTempZip, name);
    if (before.mode !== after.mode) throw new Error(`overlay changed sourceZIP mode for ${name}`);
    if (!changedEntries.has(name) && before.crc !== after.crc) throw new Error(`overlay changed sourceZIP content for ${name}`);
  }
  for (const [name, fileMode] of [['Dockerfile', dockerfileMode], ['runtime-server.mjs', runtimeMode], ['config/codex.toml', configMode],
    ['startup-responses-proxy.mjs', 0o444], ['startup-responses-proxy-manifest.json', 0o444]]) {
    const information = readModeAndCrc(outputTempZip, name);
    if (information.mode !== fileMode) throw new Error(`overlay changed expected ZIP mode for ${name}`);
  }

  const manifestFromZip = run('unzip', ['-p', outputTempZip, 'startup-responses-proxy-manifest.json']);
  if (JSON.stringify(JSON.parse(manifestFromZip)) !== JSON.stringify(manifest)) throw new Error('overlay manifest does not match the encoded proxy mode');
  renameSync(outputTempZip, outputZip);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

process.stdout.write(`created startup Responses proxy sourceZIP ${outputZip} (${mode})\n`);

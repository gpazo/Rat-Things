#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (process.argv.length !== 4 || !sourceArgument || !outputArgument) {
  throw new Error('usage: node storage-profile-image.mjs <sourceZIP> <outputZIP>');
}

const sourceZip = realpathSync(resolve(sourceArgument));
const outputZip = resolve(outputArgument);
if (sourceZip === (existsSync(outputZip) ? realpathSync(outputZip) : outputZip)) {
  throw new Error('sourceZIP and outputZIP must be different files');
}
const outputDirectory = dirname(outputZip);
if (!existsSync(outputDirectory)) mkdirSync(outputDirectory, { recursive: true });
const workDirectory = mkdtempSync(join(outputDirectory, '.storage-profile-image-'));
const contextDirectory = join(workDirectory, 'context');
const outputTempZip = join(workDirectory, 'profile-source.zip');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: contextDirectory,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? 'signal'}): ${(result.stderr ?? '').slice(-2000)}`);
  }
  return result.stdout ?? '';
};

const replaceUnique = (source, original, replacement, label) => {
  const matches = source.split(original).length - 1;
  if (matches !== 1) throw new Error(`expected one ${label} replacement point, found ${matches}`);
  return source.replace(original, replacement);
};
const executableModePaths = (dockerfile) => {
  const block = dockerfile.match(/&& chmod 0555 \\\n([\s\S]*?)\n\s*&& chown -R agent:agent/);
  if (!block) throw new Error('could not read the worker executable mode list');
  return [...block[1].matchAll(/^[ \t]+(\/opt\/agent-runtime\/[^\s]+)(?:[ \t]+\\)?$/gm)]
    .map((match) => match[1]);
};

try {
  mkdirSync(contextDirectory);
  const entryList = run('unzip', ['-Z1', sourceZip]).split(/\r?\n/).filter(Boolean);
  for (const name of entryList) {
    if (name.startsWith('/') || name.split('/').some((part) => part === '..')) {
      throw new Error('sourceZIP contains an unsafe archive path');
    }
  }
  for (const name of ['Dockerfile', 'runtime-server.mjs']) {
    if (entryList.filter((entry) => entry === name).length !== 1) {
      throw new Error(`expected one ${name} entry in sourceZIP`);
    }
  }
  if (entryList.includes('storage-profile.py')) {
    throw new Error('sourceZIP already contains storage-profile.py');
  }

  const runtimePath = join(contextDirectory, 'runtime-server.mjs');
  const dockerfilePath = join(contextDirectory, 'Dockerfile');
  run('unzip', ['-q', '-o', sourceZip, 'runtime-server.mjs', 'Dockerfile', '-d', contextDirectory]);
  const runtimeContents = readFileSync(runtimePath, 'utf8');
  const dockerfileContents = readFileSync(dockerfilePath, 'utf8');
  const wrapperContents = readFileSync(new URL('./storage-profile.py', import.meta.url));
  const runtimeMode = statSync(runtimePath).mode & 0o777;
  const dockerfileMode = statSync(dockerfilePath).mode & 0o777;
  const originalExecutablePaths = executableModePaths(dockerfileContents);

  const mountCall = `  const result = spawnSync(
    'mount',
    ['-t', 's3files', '-o', options, storage.fileSystemId, storage.mountRoot],
    { encoding: 'utf8', timeout: s3FilesMountTimeoutMs },
  );`;
  const profiledMountCall = `  const result = spawnSync(
    'python3',
    [
      '/opt/agent-runtime/storage-profile.py',
      '--timeout-ms',
      String(Math.max(1, s3FilesMountTimeoutMs - 1_000)),
      '-t',
      's3files',
      '-o',
      options,
      storage.fileSystemId,
      storage.mountRoot,
    ],
    { encoding: 'utf8', timeout: s3FilesMountTimeoutMs, maxBuffer: 16 * 1024 },
  );
  const profilePrefix = 'storage-mount-profile ';
  const profileOutput = (result.stdout ?? '').trim();
  const profileLines = profileOutput ? profileOutput.split(/\\r?\\n/) : [];
  let profileLine = null;
  if (profileLines.length === 1 && profileLines[0].startsWith(profilePrefix)) {
    try {
      const profile = JSON.parse(profileLines[0].slice(profilePrefix.length));
      const hasKeys = (value, expected) =>
        value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
      const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const integer = (value) => Number.isSafeInteger(value) && value >= 0;
      const syscallNames = new Set([
        'access', 'arch_prctl', 'brk', 'clone', 'clone3', 'close', 'connect', 'execve',
        'faccessat2', 'fstat', 'fstatfs', 'getdents64', 'getrandom', 'ioctl', 'mmap',
        'mprotect', 'munmap', 'newfstatat', 'openat', 'poll', 'ppoll', 'read',
        'recvfrom', 'recvmsg', 'select', 'sendto', 'sendmsg', 'statx', 'write', 'wait4',
      ]);
      const phaseIds = new Set([
        'helper_configured', 'mount_target_ip_selected', 'proxy_starting', 'proxy_started',
        'nfs_mount_attempt', 'mounted',
      ]);
      const regionPattern = /^[a-z]{2}(?:-[a-z0-9]+)*-[0-9]$/;
      const timestampPattern = /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} [A-Z]{2,5}$/;
      const importModulePattern = /^(?:efs_utils_common|mount_s3files)(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$/;
      const valid =
        hasKeys(profile, [
          'schema', 'outcome', 'durationMs', 'exitCode', 'rootEnv', 'validatedRegion',
          'usage', 'trace', 'phases', 'importTimings',
        ]) &&
        profile.schema === 'rat-things.storage-mount-profile.v1' &&
        ['success', 'failure'].includes(profile.outcome) &&
        finite(profile.durationMs) && integer(profile.exitCode) && profile.exitCode <= 255 &&
        ((profile.outcome === 'success') === (profile.exitCode === 0)) &&
        hasKeys(profile.rootEnv, ['awsRegionPresent', 'awsDefaultRegionPresent']) &&
        typeof profile.rootEnv.awsRegionPresent === 'boolean' &&
        typeof profile.rootEnv.awsDefaultRegionPresent === 'boolean' &&
        (profile.validatedRegion === null ||
          (typeof profile.validatedRegion === 'string' &&
            profile.validatedRegion.length <= 32 && regionPattern.test(profile.validatedRegion))) &&
        hasKeys(profile.usage, ['userMs', 'systemMs', 'majorFaults', 'minorFaults']) &&
        finite(profile.usage.userMs) && finite(profile.usage.systemMs) &&
        integer(profile.usage.majorFaults) && integer(profile.usage.minorFaults) &&
        hasKeys(profile.trace, ['scope', 'available', 'totalSeconds', 'calls', 'syscalls']) &&
        profile.trace.scope === 'mount-launcher-only' && typeof profile.trace.available === 'boolean' &&
        (profile.trace.totalSeconds === null || finite(profile.trace.totalSeconds)) &&
        (profile.trace.calls === null || integer(profile.trace.calls)) &&
        Array.isArray(profile.trace.syscalls) && profile.trace.syscalls.length <= 20 &&
        profile.trace.syscalls.every((entry) =>
          hasKeys(entry, ['name', 'calls', 'seconds']) && syscallNames.has(entry.name) &&
          integer(entry.calls) && finite(entry.seconds)) &&
        Array.isArray(profile.phases) && profile.phases.length <= 32 &&
        profile.phases.every((entry) =>
          hasKeys(entry, ['id', 'timestamp']) && phaseIds.has(entry.id) &&
          typeof entry.timestamp === 'string' && timestampPattern.test(entry.timestamp)) &&
        Array.isArray(profile.importTimings) && profile.importTimings.length <= 64 &&
        profile.importTimings.every((entry) =>
          hasKeys(entry, ['module', 'selfUs', 'cumulativeUs']) &&
          typeof entry.module === 'string' && importModulePattern.test(entry.module) &&
          integer(entry.selfUs) && integer(entry.cumulativeUs));
      if (valid) profileLine = profilePrefix + JSON.stringify(profile);
    } catch {}
  }
  if (profileLine) console.log(profileLine);
  result.stdout = '';`;
  const patchedRuntime = replaceUnique(runtimeContents, mountCall, profiledMountCall, 'S3 Files mount invocation');

  let patchedDockerfile = dockerfileContents;
  patchedDockerfile = replaceUnique(
    patchedDockerfile,
    '      shadow-utils \\\n',
    '      shadow-utils \\\n      strace \\\n',
    'profile-only strace package',
  );
  patchedDockerfile = replaceUnique(
    patchedDockerfile,
    'COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs\n',
    'COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs\nCOPY storage-profile.py /opt/agent-runtime/storage-profile.py\n',
    'profile wrapper COPY',
  );
  patchedDockerfile = replaceUnique(
    patchedDockerfile,
    'RUN chown root:root \\\n      /opt/agent-runtime/pi-child.mjs \\\n      /opt/agent-runtime/runner.mjs \\\n      /opt/agent-runtime/image-validation.mjs \\\n      /opt/agent-runtime/terminate-microvm.mjs \\\n      /opt/agent-runtime/runtime-server.mjs \\\n      /opt/agent-runtime/native-startup-probe.py \\\n',
    'RUN chown root:root \\\n      /opt/agent-runtime/pi-child.mjs \\\n      /opt/agent-runtime/runner.mjs \\\n      /opt/agent-runtime/image-validation.mjs \\\n      /opt/agent-runtime/terminate-microvm.mjs \\\n      /opt/agent-runtime/runtime-server.mjs \\\n      /opt/agent-runtime/storage-profile.py \\\n      /opt/agent-runtime/native-startup-probe.py \\\n',
    'profile wrapper root ownership',
  );
  patchedDockerfile = replaceUnique(
    patchedDockerfile,
    '    && chmod 0555 \\\n      /opt/agent-runtime/pi-child.mjs \\\n      /opt/agent-runtime/runner.mjs \\\n      /opt/agent-runtime/image-validation.mjs \\\n      /opt/agent-runtime/terminate-microvm.mjs \\\n      /opt/agent-runtime/runtime-server.mjs \\\n      /opt/agent-runtime/native-startup-probe.py \\\n',
    '    && chmod 0555 \\\n      /opt/agent-runtime/pi-child.mjs \\\n      /opt/agent-runtime/runner.mjs \\\n      /opt/agent-runtime/image-validation.mjs \\\n      /opt/agent-runtime/terminate-microvm.mjs \\\n      /opt/agent-runtime/runtime-server.mjs \\\n      /opt/agent-runtime/storage-profile.py \\\n      /opt/agent-runtime/native-startup-probe.py \\\n',
    'profile wrapper executable mode',
  );
  patchedDockerfile = replaceUnique(
    patchedDockerfile,
    'ENV NODE_ENV=production \\\n',
    'ENV NODE_ENV=production \\\n    STORAGE_PROFILE_IMPORTTIME=1 \\\n',
    'profile-only import timing setting',
  );
  const patchedExecutablePaths = executableModePaths(patchedDockerfile);
  let previousPathIndex = -1;
  for (const path of originalExecutablePaths) {
    const nextPathIndex = patchedExecutablePaths.indexOf(path, previousPathIndex + 1);
    if (nextPathIndex <= previousPathIndex) {
      throw new Error(`profile overlay removed or reordered original executable mode ${path}`);
    }
    previousPathIndex = nextPathIndex;
  }
  if (
    patchedExecutablePaths.length !== originalExecutablePaths.length + 1 ||
    patchedExecutablePaths.filter((path) => path === '/opt/agent-runtime/storage-profile.py').length !== 1
  ) {
    throw new Error('profile overlay must add only the profile wrapper to the executable mode list');
  }

  writeFileSync(runtimePath, patchedRuntime, { mode: runtimeMode });
  chmodSync(runtimePath, runtimeMode);
  writeFileSync(dockerfilePath, patchedDockerfile, { mode: dockerfileMode });
  chmodSync(dockerfilePath, dockerfileMode);
  const wrapperPath = join(contextDirectory, 'storage-profile.py');
  writeFileSync(wrapperPath, wrapperContents, { mode: 0o555 });
  chmodSync(wrapperPath, 0o555);

  copyFileSync(sourceZip, outputTempZip);
  const zipResult = spawnSync('zip', ['-q', '-u', outputTempZip, 'Dockerfile', 'runtime-server.mjs', 'storage-profile.py'], {
    cwd: contextDirectory,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (zipResult.error) throw zipResult.error;
  if (zipResult.status !== 0) {
    throw new Error(`zip update failed (${zipResult.status ?? 'signal'}): ${(zipResult.stderr ?? '').slice(-2000)}`);
  }

  const patchedEntries = run('unzip', ['-Z1', outputTempZip]).split(/\r?\n/).filter(Boolean);
  const sourceCounts = new Map();
  for (const name of entryList) sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + 1);
  const patchedCounts = new Map();
  for (const name of patchedEntries) patchedCounts.set(name, (patchedCounts.get(name) ?? 0) + 1);
  for (const [name, count] of sourceCounts) {
    if (patchedCounts.get(name) !== count) throw new Error(`profile overlay changed sourceZIP entry count for ${name}`);
  }
  if (patchedCounts.get('storage-profile.py') !== 1 || patchedCounts.size !== sourceCounts.size + 1) {
    throw new Error('profile overlay must add only storage-profile.py');
  }
  for (const name of ['Dockerfile', 'runtime-server.mjs', 'storage-profile.py']) {
    if (patchedEntries.filter((entry) => entry === name).length !== 1) {
      throw new Error(`profile sourceZIP does not contain exactly one ${name}`);
    }
  }
  for (const [name, expectedMode] of [
    ['Dockerfile', dockerfileMode],
    ['runtime-server.mjs', runtimeMode],
    ['storage-profile.py', 0o555],
  ]) {
    const info = run('unzip', ['-Z', '-v', outputTempZip, name]);
    const modeMatch = info.match(/Unix file attributes \(([0-7]+) octal\):/);
    if (!modeMatch || (Number.parseInt(modeMatch[1], 8) & 0o777) !== expectedMode) {
      throw new Error(`profile sourceZIP changed the expected mode for ${name}`);
    }
  }
  renameSync(outputTempZip, outputZip);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

process.stdout.write(`created diagnostic sourceZIP ${outputZip}\n`);

export const codexRuntimeTargets = {
  'darwin-arm64': {
    platform: 'darwin', arch: 'arm64', nativeTarget: 'aarch64-apple-darwin',
    vendorTarget: 'aarch64-apple-darwin', packageName: '@openai/codex-darwin-arm64',
  },
  'linux-arm64': {
    platform: 'linux', arch: 'arm64', nativeTarget: 'aarch64-unknown-linux-gnu',
    vendorTarget: 'aarch64-unknown-linux-musl', packageName: '@openai/codex-linux-arm64', elfMachine: 183,
  },
  'linux-x64': {
    platform: 'linux', arch: 'x64', nativeTarget: 'x86_64-unknown-linux-gnu',
    vendorTarget: 'x86_64-unknown-linux-musl', packageName: '@openai/codex-linux-x64', elfMachine: 62,
  },
};

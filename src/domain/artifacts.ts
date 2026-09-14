export const MAX_ARTIFACT_FILES = 5_000;
export const MAX_ARTIFACT_PATH_BYTES = 512;

export function validateArtifactPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => (
      !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255
    )) ||
    Buffer.byteLength(path, 'utf8') > MAX_ARTIFACT_PATH_BYTES ||
    /[\0-\x1f\x7f]/.test(path)
  ) throw new Error(`invalid artifact path ${JSON.stringify(path)}`);
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeHostFacts, type NativeHostFacts } from '../domain/local-native-admission.js';

const exec = promisify(execFile);
export async function readNativeHostFacts(helper: string): Promise<NativeHostFacts> {
  const result = await exec(helper, ['--host-facts'], { timeout: 5000, maxBuffer: 4096, encoding: 'utf8', env: {} });
  return nativeHostFacts(JSON.parse(result.stdout));
}

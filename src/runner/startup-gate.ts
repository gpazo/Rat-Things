import { Socket } from 'node:net';
const releaseByte = 0x52;
const startupGateTimeoutMs = 60_000;

export function awaitStartupRelease(
  descriptor = process.env.RT_STARTUP_GATE_FD,
  timeoutMs = startupGateTimeoutMs,
): Promise<void> {
  if (descriptor === undefined) return Promise.resolve();
  if (descriptor !== '4') return Promise.reject(new Error('invalid startup gate descriptor'));

  return new Promise((resolve, reject) => {
    const stream = new Socket({ fd: Number(descriptor), readable: true, writable: false });
    let received = 0;
    let token: number | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const onData = (chunk: Buffer) => {
      if (received === 0 && chunk.length > 0) token = chunk[0];
      received += chunk.length;
      if (received > 1 || (received === 1 && token !== releaseByte)) {
        finish(new Error('startup gate release was malformed'));
      }
    };
    const onEnd = () => {
      finish(received === 1 && token === releaseByte
        ? undefined
        : new Error('startup gate closed before release'));
    };
    const deadline = setTimeout(() => finish(new Error('startup gate timed out')), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', (error) => finish(error));
  });
}

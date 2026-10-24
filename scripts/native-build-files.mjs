import { constants, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const maximumInputBytes = 768 * 1024 ** 2;

export async function* regularFileChunks(path, maximumBytes = maximumInputBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Native build input must be a regular file.');
    if (stat.size > maximumBytes) throw new Error('Native build input exceeds its byte limit.');
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      total += bytesRead;
      if (total > maximumBytes) throw new Error('Native build input exceeds its byte limit.');
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

export async function readRegularFile(path, maximumBytes) {
  const chunks = [];
  for await (const chunk of regularFileChunks(path, maximumBytes)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function copyRegularFile(source, destination, maximumBytes) {
  await pipeline(Readable.from(regularFileChunks(source, maximumBytes)),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

/** Serialized as a fixed argument to Node inside the executor; never interpolated with input. */
export async function environmentFileWorker() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const path = await import('node:path');
  const { randomUUID, createHash } = await import('node:crypto');
  const { createInterface } = await import('node:readline');
  const root = await fs.realpath(process.cwd());
  const input = createInterface({ input: process.stdin });
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  async function absolute(value: unknown, directory = false): Promise<string> {
    if (typeof value !== 'string' || value.includes('\0') || value.split('/').some((part) => part === '..' || part === '.') || !(value === '/workspace' || value.startsWith('/workspace/'))) throw new Error('Invalid workspace path');
    const relative = value.slice('/workspace'.length).replace(/^\//, '');
    if (!directory && !relative) throw new Error('Expected a file path');
    let current = root;
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are outside the workspace API'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    }
    return current;
  }
  async function files(directory: string): Promise<Array<{ path: string; size_bytes: number }>> {
    const result: Array<{ path: string; size_bytes: number }> = [];
    const pending = [directory];
    let visited = 0;
    while (pending.length) {
      for (const entry of await fs.readdir(pending.pop()!, { withFileTypes: true })) {
        if (++visited > 10_000) throw new Error('Narrow the file listing to a smaller directory');
        const target = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && !entry.name.startsWith('.rat-upload-')) result.push({ path: `/workspace/${path.relative(root, target).split(path.sep).join('/')}`, size_bytes: (await fs.stat(target)).size });
      }
    }
    return result;
  }
  input.on('line', (line) => {
    void (async () => {
      const request = JSON.parse(line) as { id?: string | number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
      if (request.id === undefined) return;
      let result: unknown;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rat-environment-files', version: '1' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: [{ name: 'files', description: 'Manage files inside the admitted workspace', inputSchema: { type: 'object', additionalProperties: true } }] };
      else if (request.method === 'tools/call' && request.params?.name === 'files') {
        try {
          const args = request.params.arguments ?? {};
          let data: unknown;
          if (args.operation === 'list') {
            try { data = await files(await absolute(args.path ?? '/workspace', true)); }
            catch (error) { if (args.missingOk === true && error instanceof Error && 'code' in error && error.code === 'ENOENT') data = []; else throw error; }
          }
          else if (args.operation === 'read') {
            if (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || !Number.isSafeInteger(args.length) || Number(args.length) < 1 || Number(args.length) > 1024 * 1024) throw new Error('Invalid read range');
            const handle = await fs.open(await absolute(args.path), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const before = await handle.stat();
              if (!before.isFile()) throw new Error('Expected a regular file');
              const bytes = Buffer.alloc(Number(args.length));
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, Number(args.offset));
              const after = await handle.stat();
              if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('File changed during read');
              data = { path: args.path, data: bytes.subarray(0, bytesRead).toString('base64'), size_bytes: after.size, version: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}` };
            } finally { await handle.close(); }
          }
          else if (args.operation === 'write_chunk' || args.operation === 'write_abort') {
            if (typeof args.uploadId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(args.uploadId)) throw new Error('Invalid upload identity');
            const target = await absolute(args.path);
            const temporary = path.join(path.dirname(target), `.rat-upload-${args.uploadId}`);
            if (args.operation === 'write_abort') { await fs.rm(temporary, { force: true }); data = {}; }
            else {
              if (typeof args.data !== 'string' || args.data.length > 1_398_104 || typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.sha256) || !Number.isSafeInteger(args.offset) || !Number.isSafeInteger(args.size) || Number(args.offset) < 0 || Number(args.size) > 50 * 1024 * 1024) throw new Error('Invalid upload chunk');
              const bytes = Buffer.from(args.data, 'base64');
              if (bytes.toString('base64') !== args.data || bytes.length > 1024 * 1024 || !bytes.length || Number(args.offset) + bytes.length > Number(args.size)) throw new Error('Invalid upload range');
              await fs.mkdir(path.dirname(target), { recursive: true }); await absolute(args.path);
              const handle = await fs.open(temporary, constants.O_RDWR | constants.O_NOFOLLOW | (args.offset === 0 ? constants.O_CREAT : 0), 0o600);
              let complete = false;
              try {
                const current = await handle.stat();
                if (!current.isFile() || current.nlink !== 1 || current.size < Number(args.offset) || current.size > Number(args.offset) + bytes.length) throw new Error('Upload offset changed');
                let written = 0;
                while (written < bytes.length) {
                  const result = await handle.write(bytes, written, bytes.length - written, Number(args.offset) + written);
                  if (!result.bytesWritten) throw new Error('Upload write did not progress');
                  written += result.bytesWritten;
                }
                complete = Number(args.offset) + bytes.length === args.size;
                if (complete) {
                  const digest = createHash('sha256');
                  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
                  if (digest.digest('hex') !== args.sha256) throw new Error('Upload checksum mismatch');
                }
              } finally { await handle.close(); }
              if (complete) { await absolute(args.path); await fs.rename(temporary, target); }
              data = { path: args.path, size_bytes: Number(args.offset) + bytes.length };
            }
          }
          else if (args.operation === 'write') {
            const target = await absolute(args.path);
            if (typeof args.data !== 'string' || Buffer.byteLength(args.data) > 8 * 1024 * 1024) throw new Error('Invalid file content');
            const bytes = Buffer.from(args.data, 'base64');
            if (bytes.toString('base64') !== args.data) throw new Error('Invalid base64');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await absolute(args.path);
            const temporary = path.join(path.dirname(target), `.rat-upload-${randomUUID()}`);
            try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, target); }
            finally { await fs.rm(temporary, { force: true }); }
            data = { path: args.path, size_bytes: bytes.length };
          } else throw new Error('Unknown workspace operation');
          result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch { result = { content: [{ type: 'text', text: 'Workspace file operation failed' }], isError: true }; }
      } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ jsonrpc: '2.0', id: request.id, result });
    })().catch(() => {});
  });
}

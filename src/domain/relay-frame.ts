/** Read only the routing envelope; encrypted Noise payloads remain opaque to the relay. */
export function relayStreamId(bytes: Uint8Array): string {
  if (bytes.byteLength > 256 * 1024) throw new Error('Relay frame exceeds the protocol limit');
  let offset = 0;
  let version = 0;
  let streamId: string | undefined;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 35 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) return value;
    }
    throw new Error('Invalid relay frame integer');
  };
  while (offset < bytes.length) {
    const tag = varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error('Invalid relay frame field');
    if (wire === 0) { const value = varint(); if (field === 1) version = value; }
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error('Truncated relay frame');
      if (field === 2) {
        if (streamId !== undefined || length > 256) throw new Error('Invalid relay stream ID');
        streamId = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length));
      }
      offset += length;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error('Unsupported relay frame wire type');
    if (offset > bytes.length) throw new Error('Truncated relay frame');
  }
  if (version !== 1 || !streamId) throw new Error('Invalid relay frame version or stream ID');
  return streamId;
}

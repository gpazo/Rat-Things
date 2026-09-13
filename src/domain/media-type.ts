export function detectMediaType(bytes: Uint8Array, path: string): string {
  const value = Buffer.from(bytes);
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
  if (value.subarray(0, 6).toString('ascii') === 'GIF87a' || value.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (value.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = value.subarray(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (extension === 'm4a' || extension === 'm4b') return 'audio/mp4';
    if (extension === 'mov') return 'video/quicktime';
    return 'video/mp4';
  }
  if (value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (value.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (value.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (value.subarray(0, 4).toString('ascii') === 'OggS') {
    return extension === 'ogv' ? 'video/ogg' : 'audio/ogg';
  }
  const textual: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json',
    m3u8: 'application/vnd.apple.mpegurl',
    md: 'text/markdown; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
    webmanifest: 'application/manifest+json',
    xml: 'application/xml',
  };
  if (extension && textual[extension] && !value.includes(0)) return textual[extension];
  const binary: Record<string, string> = {
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    ogv: 'video/ogg',
    opus: 'audio/ogg',
    wasm: 'application/wasm',
    wav: 'audio/wav',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  if (extension && binary[extension]) return binary[extension];
  return 'application/octet-stream';
}

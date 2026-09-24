import { isIP } from 'node:net';

/** Destinations reachable by a trusted host on behalf of an untrusted caller. */
export function publicNetworkAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 &&
      !(a === 100 && b! >= 64 && b! <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && (b === 168 || b === 0 || b === 2)) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
}

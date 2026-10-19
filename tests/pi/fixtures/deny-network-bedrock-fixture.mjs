import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';

const fixturePort = Number(process.env.PI_TEST_BEDROCK_PORT);
if (!Number.isInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535) {
  throw new Error('Pi test transport fixture is unavailable');
}

const bedrockHost = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;
const nodeHttp2Connect = http2.connect;
const blockedRequest = () => { throw new Error('Blocked non-fixture network request'); };

http.request = blockedRequest;
http.get = blockedRequest;
https.request = blockedRequest;
https.get = blockedRequest;
http2.connect = function connect(authority, options, listener) {
  const url = new URL(authority);
  if (url.protocol !== 'https:' || !bedrockHost.test(url.hostname) || (url.port !== '' && url.port !== '443')) {
    throw new Error('Blocked non-fixture network request');
  }
  return nodeHttp2Connect.call(http2, `http://127.0.0.1:${fixturePort}`, options, listener);
};
globalThis.fetch = async () => { throw new Error('Blocked non-fixture network request'); };
syncBuiltinESMExports();

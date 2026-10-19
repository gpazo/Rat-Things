import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const fixturePort = Number(process.env.PI_TEST_BEDROCK_PORT);
if (!Number.isInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535) {
  throw new Error('Pi test transport fixture is unavailable');
}

const bedrockHost = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;
const nodeHttpRequest = http.request;

function requestTarget(input, options) {
  if (typeof input === 'string' || input instanceof URL) {
    const url = new URL(input);
    return { ...options, protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}` };
  }
  return { ...(input ?? {}), ...(options ?? {}) };
}

function guardedRequest(original, protocol) {
  return function request(input, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    const target = requestTarget(input, options);
    const host = String(target.hostname ?? target.host ?? '').replace(/:\d+$/, '');
    const port = Number(target.port ?? (target.protocol === 'https:' ? 443 : 80));
    const path = String(target.path ?? '/');
    if (bedrockHost.test(host) && target.method === 'POST' && path.includes('/converse-stream')) {
      return nodeHttpRequest.call(http, { ...target, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: fixturePort,
        path, agent: false, servername: undefined }, callback);
    }
    if (protocol === 'http:' && host === '127.0.0.1' && port === fixturePort) {
      return original.call(protocol === 'https:' ? https : http, input, options, callback);
    }
    throw new Error('Blocked non-fixture network request');
  };
}

http.request = guardedRequest(http.request, 'http:');
http.get = guardedRequest(http.get, 'http:');
https.request = guardedRequest(https.request, 'https:');
https.get = guardedRequest(https.get, 'https:');
globalThis.fetch = async () => { throw new Error('Blocked non-fixture network request'); };
syncBuiltinESMExports();

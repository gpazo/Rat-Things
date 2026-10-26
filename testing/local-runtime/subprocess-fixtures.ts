/** Programs exercising subprocess behavior in the official Codex sandbox. */
export const nodeSubprocessStdioProbe = String.raw`
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const child = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write('out:'+input);process.stderr.write('err:'+input)});";
// Newer Node 22 releases announce their environment proxy on stderr at startup.
// Exclude that known warning while still asserting every byte from the child.
const nodeArgs = program => ['--disable-warning=UNDICI-EHPA', '-e', program];
const sync = spawnSync(process.execPath, nodeArgs(child), { input: 'sync', encoding: 'utf8', timeout: 3000 });
assert.equal(sync.error, undefined);
assert.equal(sync.status, 0);
assert.equal(sync.stdout, 'out:sync');
assert.equal(sync.stderr, 'err:sync');
const failed = spawnSync(process.execPath, nodeArgs("console.error('intentional-failure');process.exitCode=7"), { encoding: 'utf8', timeout: 3000 });
assert.equal(failed.error, undefined);
assert.equal(failed.status, 7);
assert.equal(failed.stderr, 'intentional-failure\n');
const asyncChild = spawn(process.execPath, nodeArgs(child));
let stdout = '', stderr = '';
asyncChild.stdout.on('data', chunk => stdout += chunk);
asyncChild.stderr.on('data', chunk => stderr += chunk);
asyncChild.on('error', error => { throw error; });
asyncChild.stdin.on('error', error => { throw error; });
asyncChild.on('close', code => {
    assert.equal(code, 0);
    assert.equal(stdout, 'out:async');
    assert.equal(stderr, 'err:async');
    console.log('local-subprocess-stdio-ok');
});
asyncChild.stdin.end('async');
`;

/** Proxy isolation permits local metadata; actual egress and named Unix sockets remain denied. */
export const restrictedNetworkSocketProbe = String.raw`
import errno, os, socket, urllib.request, urllib.error

def denied(operation):
    try:
        operation()
    except PermissionError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError('operation was not denied with EPERM')

left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
assert left.getsockname() == ''
assert left.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM
os.write(left.fileno(), b'local')
assert os.read(right.fileno(), 5) == b'local'
left.shutdown(socket.SHUT_WR)
assert os.read(right.fileno(), 1) == b''
left.close()
right.close()
for family in (socket.AF_UNIX, socket.AF_VSOCK, socket.AF_NETLINK):
    denied(lambda: socket.socket(family, socket.SOCK_STREAM))
for family in (socket.AF_INET, socket.AF_INET6, socket.AF_VSOCK, socket.AF_NETLINK):
    denied(lambda: socket.socketpair(family, socket.SOCK_STREAM))
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as endpoint:
    endpoint.settimeout(1)
    try:
        endpoint.connect(('192.0.2.1', 443))
    except OSError:
        pass
    else:
        raise AssertionError('direct external connection was allowed')
proxy = os.environ.get('HTTP_PROXY')
assert proxy, 'managed proxy was not installed'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy}))
try:
    opener.open('http://example.invalid/', timeout=2)
except urllib.error.HTTPError as error:
    assert error.code == 403, error.code
    assert b'"reason":"not_allowed"' in error.read()
else:
    raise AssertionError('proxy egress was allowed')
print('local-socket-only-ok')
`;

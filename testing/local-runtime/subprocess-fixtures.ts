/** Exact programs shared with the pinned Codex local-subprocess-stdio regression tests. */
export const nodeSubprocessStdioProbe = String.raw`
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const child = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write('out:'+input);process.stderr.write('err:'+input)});";
const sync = spawnSync(process.execPath, ['-e', child], { input: 'sync', encoding: 'utf8', timeout: 3000 });
assert.equal(sync.error, undefined);
assert.equal(sync.status, 0);
assert.equal(sync.stdout, 'out:sync');
assert.equal(sync.stderr, 'err:sync');
const failed = spawnSync(process.execPath, ['-e', "console.error('intentional-failure');process.exitCode=7"], { encoding: 'utf8', timeout: 3000 });
assert.equal(failed.error, undefined);
assert.equal(failed.status, 7);
assert.equal(failed.stderr, 'intentional-failure\n');
const asyncChild = spawn(process.execPath, ['-e', child]);
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

/** Require precise syscall denials; missing Python, socket families, or sandbox support fail. */
export const restrictedNetworkSocketProbe = String.raw`
import errno, os, socket

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
# Each mismatching field independently denies, including both mismatching.
denied(lambda: right.getsockopt(socket.IPPROTO_TCP, socket.SO_TYPE))
denied(lambda: right.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR))
denied(lambda: right.getsockopt(socket.IPPROTO_TCP, socket.SO_ERROR))
denied(lambda: right.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65536))
denied(lambda: right.getpeername())
denied(lambda: right.shutdown(socket.SHUT_RD))
denied(lambda: right.shutdown(socket.SHUT_RDWR))
left.close()
right.close()
for family in (socket.AF_INET, socket.AF_INET6, socket.AF_VSOCK, socket.AF_NETLINK):
    denied(lambda: socket.socket(family, socket.SOCK_STREAM))
    denied(lambda: socket.socketpair(family, socket.SOCK_STREAM))
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as endpoint:
    denied(lambda: endpoint.bind('/tmp/rat-network-denied'))
    denied(lambda: endpoint.connect('/tmp/rat-network-denied'))
    denied(lambda: endpoint.listen(1))
    denied(lambda: endpoint.accept())
print('local-socket-only-ok')
`;

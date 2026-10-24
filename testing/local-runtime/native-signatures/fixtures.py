#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import struct
import subprocess
import tempfile

IDENTITY = 'Developer ID Application: Gregory Pazo (PB8NAVKU57)'
BUNDLE_ID = 'dev.rat-things.runtime'
EXECUTABLES = {
    'Contents/Helpers/rat-native-worker': ('vm-helper', BUNDLE_ID + '.vm-helper'),
    'Contents/Resources/codex/bin/codex': ('host-codex', BUNDLE_ID + '.codex'),
    'Contents/Resources/codex/bin/codex-code-mode-host': ('host-companion', BUNDLE_ID + '.code-mode-host'),
    'Contents/Resources/codex/codex-path/rg': ('host-companion', BUNDLE_ID + '.ripgrep'),
    'Contents/Resources/codex/codex-resources/zsh/bin/zsh': ('host-companion', BUNDLE_ID + '.zsh'),
}
SIGNATURES = {'CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'}
MANIFEST = 'Contents/Resources/runtime-manifest.json'
LIMITS = [4096, 768 * 1024 * 1024, 2 * 1024 * 1024 * 1024, 128 * 1024, 32, 1024]
REQUIREMENT = ('anchor apple generic and identifier "dev.rat-things.runtime" and '
               'certificate 1[field.1.2.840.113635.100.6.2.6] exists and '
               'certificate leaf[field.1.2.840.113635.100.6.1.13] exists and '
               'certificate leaf[subject.OU] = "PB8NAVKU57"')


def main():
    parser = argparse.ArgumentParser(description='Validate signed runtime bundles using inert fixture executables.')
    parser.add_argument('--verifier', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    verifier = args.verifier.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='fixtures-', dir=args.output)).resolve()
    records, commands = [], []
    env = dict(os.environ, TMPDIR=str(root), CLANG_MODULE_CACHE_PATH=str(root / 'cache'))

    def command(argv, expected=0):
        result = subprocess.run([str(a) for a in argv], env=env, capture_output=True, timeout=60)
        commands.append({'argv': [str(a) for a in argv], 'exitCode': result.returncode,
                         'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')})
        if expected is not None and result.returncode != expected:
            raise RuntimeError(json.dumps(commands[-1]))
        return result

    def sign(path, identifier, identity=IDENTITY):
        command(['/usr/bin/codesign', '--force', '--sign', identity, '--timestamp=none',
                 '--options', 'runtime', '--identifier', identifier, path])

    def write_manifest(bundle, edit=lambda value: None):
        files = []
        for path in sorted(bundle.rglob('*')):
            relative = path.relative_to(bundle).as_posix()
            if not path.is_file() or relative == MANIFEST or relative.startswith('Contents/_CodeSignature/'):
                continue
            item = {'path': relative, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    'kind': 'resource'}
            if relative in EXECUTABLES:
                item.update(kind='host-executable', role=EXECUTABLES[relative][0])
            files.append(item)
        value = {'schemaVersion': 1, 'version': 'signed-fixture', 'files': files,
                 'compatibility': {'hostTarget': 'aarch64-apple-darwin', 'guestTarget': 'aarch64-unknown-linux-musl',
                                   'minimumMacOS': '13.0', 'appProtocol': {'minimum': 1, 'maximum': 1},
                                   'controllerProtocol': {'minimum': 1, 'maximum': 1}, 'workerProtocol': 1,
                                   'workspaceFormat': {'read': [1], 'write': 1}, 'accountStateFormat': 1, 'profileSchema': 1}}
        edit(value)
        (bundle / MANIFEST).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')

    def clone(name):
        target = root / name / 'Runtime.bundle'
        shutil.copytree(base, target)
        return target

    def verify(name, bundle, accepted, stage=None, reason=None, limits=LIMITS):
        result = command([verifier, 'verify-runtime', bundle, *limits], expected=None)
        value = json.loads(result.stdout)
        actual = result.returncode == 0 and value['kind'] == 'authenticated'
        passed = actual == accepted and (stage is None or value.get('stage') == stage)
        passed = passed and (reason is None or value.get('failure', {}).get('reason') == reason)
        if actual:
            passed = passed and set(value['executablePaths']) == set(EXECUTABLES)
            passed = passed and base64.b64decode(value['manifestBase64'], validate=True) == (bundle / MANIFEST).read_bytes()
        record = {'name': name, 'bundle': str(bundle), 'accepted': actual, 'passed': passed,
                  'exitCode': result.returncode, 'stage': value.get('stage'), 'failure': value.get('failure')}
        records.append(record)
        print(json.dumps(record), flush=True)
        if not passed:
            raise RuntimeError(f'Unexpected result for {name}')
        return value

    try:
        source = root / 'fixture.c'
        source.write_text('int main(void) { return 0; }\n')
        binary = root / 'fixture'
        command(['xcrun', 'clang', '-arch', 'arm64', '-arch', 'x86_64', source, '-o', binary])
        base = root / 'good' / 'Runtime.bundle'
        (base / 'Contents/Resources/licenses').mkdir(parents=True)
        (base / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': BUNDLE_ID, 'CFBundleName': 'Runtime', 'CFBundlePackageType': 'BNDL', 'CFBundleVersion': '1',
        }))
        for path, (_, identifier) in EXECUTABLES.items():
            target = base / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(binary, target)
            target.chmod(0o755)
            sign(target, identifier)
        for path in ['Contents/Resources/kernel', 'Contents/Resources/initramfs', 'Contents/Resources/licenses/LICENSE',
                     'Contents/Resources/codex/codex-package.json']:
            (base / path).write_text('Inert signature fixture resource.\n')
        write_manifest(base)
        sign(base, BUNDLE_ID)
        assert {path.name for path in (base / 'Contents/_CodeSignature').iterdir()} == SIGNATURES
        command(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--all-architectures', '--verbose=4', base])
        command(['/usr/bin/codesign', '--display', '--requirements', '-', '--verbose=4', base])
        for path in EXECUTABLES:
            command(['/usr/bin/codesign', '--display', '--requirements', '-', '--verbose=4', base / path])
        verify('valid-five-executable-layout', base, True)
        verify('production-ceilings-clamp', base, True, limits=[9_007_199_254_740_991] * 6)
        source_copy = clone('copy-source')
        installed = root / 'installed' / 'Runtime.bundle'
        shutil.copytree(source_copy, installed)
        shutil.rmtree(source_copy.parent)
        for path in installed.rglob('*'):
            path.chmod(0o555 if path.is_dir() or path.relative_to(installed).as_posix() in EXECUTABLES else 0o444)
        installed.chmod(0o555)
        verify('copied-readonly-source-removed', installed, True)

        for name, path in [('tampered-manifest', MANIFEST), ('tampered-resource', 'Contents/Resources/kernel')]:
            bundle = clone(name)
            with (bundle / path).open('ab') as handle:
                handle.write(b'changed')
            verify(name, bundle, False, 'bundle-signature', 'invalid')
        for path in EXECUTABLES:
            name = 'tampered-' + Path(path).name
            bundle = clone(name)
            data = bytearray((bundle / path).read_bytes())
            _, count = struct.unpack_from('>II', data)
            for index in range(count):
                cpu, _, offset, size, _ = struct.unpack_from('>IIIII', data, 8 + index * 20)
                if cpu == 0x0100000C:
                    data[offset + min(4096, size - 1)] ^= 1
                    break
            else:
                raise AssertionError('Universal fixture has no arm64 architecture')
            (bundle / path).write_bytes(data)
            verify(name, bundle, False)
        bundle = clone('tampered-non-native-architecture')
        helper = bundle / next(iter(EXECUTABLES))
        data = bytearray(helper.read_bytes())
        magic, count = struct.unpack_from('>II', data)
        assert magic == 0xCAFEBABE
        for index in range(count):
            cpu, _, offset, size, _ = struct.unpack_from('>IIIII', data, 8 + index * 20)
            if cpu == 0x01000007:
                data[offset + min(4096, size - 1)] ^= 1
                break
        else:
            raise AssertionError('Universal fixture has no x86_64 architecture')
        helper.write_bytes(data)
        verify('tampered-non-native-architecture', bundle, False)

        for name, identifier, identity, reason in [
            ('wrong-outer-identifier', BUNDLE_ID + '.wrong', IDENTITY, 'wrong_identifier'),
            ('adhoc-outer', BUNDLE_ID, '-', 'ad_hoc'),
        ]:
            bundle = clone(name)
            sign(bundle, identifier, identity)
            verify(name, bundle, False, 'bundle-signature', reason)
        bundle = clone('unsigned-outer')
        command(['/usr/bin/codesign', '--remove-signature', bundle])
        verify('unsigned-outer', bundle, False)
        for path, (_, identifier) in EXECUTABLES.items():
            for variant in ['wrong-id', 'adhoc']:
                name = variant + '-' + Path(path).name
                bundle = clone(name)
                sign(bundle / path, identifier + '.wrong' if variant == 'wrong-id' else identifier,
                     IDENTITY if variant == 'wrong-id' else '-')
                write_manifest(bundle)
                sign(bundle, BUNDLE_ID)
                command(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--all-architectures', bundle])
                verify(name, bundle, False, 'executable-signature', 'wrong_identifier' if variant == 'wrong-id' else 'ad_hoc')
        bundle = clone('unsigned-nested')
        command(['/usr/bin/codesign', '--remove-signature', bundle / next(iter(EXECUTABLES))])
        verify('unsigned-nested', bundle, False)

        for name, change in [
            ('executable-inventory-omitted', lambda value: value['files'].pop(next(i for i, item in enumerate(value['files']) if item['path'] in EXECUTABLES))),
            ('executable-inventory-resource', lambda value: next(item for item in value['files'] if item['path'] in EXECUTABLES).update(kind='resource')),
        ]:
            bundle = clone(name)
            write_manifest(bundle, change)
            sign(bundle, BUNDLE_ID)
            value = verify(name, bundle, True)
            manifest = json.loads(base64.b64decode(value['manifestBase64']))
            assert set(item['path'] for item in manifest['files'] if item['kind'] == 'host-executable') != set(value['executablePaths'])
        bundle = clone('authenticated-malformed-manifest')
        (bundle / MANIFEST).write_bytes(b'\xffthis is not JSON')
        sign(bundle, BUNDLE_ID)
        verify('authenticated-malformed-manifest', bundle, True)

        def socket_file(bundle):
            stream = socket.socket(socket.AF_UNIX)
            previous = Path.cwd()
            try:
                os.chdir(bundle)
                stream.bind('Contents/Resources/s')
            finally:
                stream.close()
                os.chdir(previous)

        for name, mutation in [
            ('symlink-file', lambda bundle: (bundle / 'Contents/Resources/evil').symlink_to('/etc/passwd')),
            ('symlink-directory', lambda bundle: (bundle / 'Contents/Resources/evil').symlink_to('/tmp', target_is_directory=True)),
            ('hardlink-file', lambda bundle: os.link(bundle / 'Contents/Resources/kernel', bundle / 'Contents/Resources/evil')),
            ('fifo', lambda bundle: os.mkfifo(bundle / 'Contents/Resources/evil')),
            ('socket', socket_file),
            ('noncanonical-unicode', lambda bundle: (bundle / 'Contents/Resources/e\u0301').write_text('x')),
            ('hostile-colon', lambda bundle: (bundle / 'Contents/Resources/evil:name').write_text('x')),
            ('hostile-backslash', lambda bundle: (bundle / 'Contents/Resources/evil\\name').write_text('x')),
            ('hostile-control', lambda bundle: (bundle / 'Contents/Resources/evil\nname').write_text('x')),
            ('unknown-signature-metadata', lambda bundle: (bundle / 'Contents/_CodeSignature/extra').write_text('x')),
            ('world-writable-file', lambda bundle: (bundle / 'Contents/Resources/kernel').chmod(0o666)),
            ('setuid-file', lambda bundle: (bundle / next(iter(EXECUTABLES))).chmod(0o4755)),
            ('setgid-directory', lambda bundle: (bundle / 'Contents/Resources').chmod(0o2755)),
            ('unknown-executable', lambda bundle: shutil.copy2(binary, bundle / 'Contents/Helpers/unknown')),
            ('hidden-mach-o-resource', lambda bundle: (shutil.copyfile(binary, bundle / 'Contents/Resources/hidden'), (bundle / 'Contents/Resources/hidden').chmod(0o644))),
            ('missing-known-executable', lambda bundle: (bundle / next(iter(EXECUTABLES))).unlink()),
            ('non-executable-known-binary', lambda bundle: (bundle / next(iter(EXECUTABLES))).chmod(0o644)),
        ]:
            bundle = clone(name)
            mutation(bundle)
            verify(name, bundle, False, 'filesystem')
        bundle = clone('symlink-root')
        link = root / 'bundle-link'
        link.symlink_to(bundle, target_is_directory=True)
        verify('symlink-root', link, False, 'filesystem')
        for name, index, limit in [('entry-bound', 0, 1), ('file-bound', 1, 64 * 1024), ('total-bound', 2, 128 * 1024),
                                   ('manifest-bound', 3, 1), ('depth-bound', 4, 2), ('path-bound', 5, 8)]:
            limits = LIMITS.copy()
            limits[index] = limit
            if index in [1, 2]:
                limits[1] = min(limits[1], limits[2])
                limits[3] = min(limits[3], limits[1])
            verify(name, base, False, 'bounds', limits=limits)
        bundle = clone('oversized-sparse-file')
        with (bundle / 'Contents/Resources/kernel').open('wb') as handle:
            handle.truncate(LIMITS[1] + 1)
        verify('oversized-sparse-file', bundle, False, 'bounds')
        bundle = clone('oversized-info-plist')
        (bundle / 'Contents/Info.plist').write_bytes(b'x' * (64 * 1024 + 1))
        verify('oversized-info-plist', bundle, False, 'bounds')

        wrong_team = command(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--all-architectures',
                              '-R', REQUIREMENT.replace('PB8NAVKU57', 'AAAAAAAAAA'), base], expected=None)
        assert wrong_team.returncode != 0
        records.append({'name': 'fixed-team-requirement-negative-control', 'passed': True,
                        'note': 'The actual PB8NAVKU57 signature fails the same requirement with a different fixed team. A foreign-team Apple identity was unavailable.'})
    finally:
        (root / 'results.json').write_text(json.dumps(records, indent=2) + '\n')
        (root / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        (args.output / 'latest-run.txt').write_text(str(root) + '\n')
    print(json.dumps({'run': str(root), 'passed': len(records), 'failed': sum(not item['passed'] for item in records)}))


if __name__ == '__main__':
    main()

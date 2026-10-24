# Run the native signature fixtures

Run this suite on macOS with Xcode and the existing Developer ID Application identity for team `PB8NAVKU57`. The fixture signs inert universal binaries. It never boots a VM, reads account credentials, or submits for notarization.

Build the verifier in a private temporary directory. From the repository root, run these commands.

```sh
signature_work=$(mktemp -d /tmp/rat-native-signature-XXXXXX)
mkdir "$signature_work/cache" "$signature_work/tmp"
TMPDIR="$signature_work/tmp" CLANG_MODULE_CACHE_PATH="$signature_work/cache" \
  xcrun swiftc -module-cache-path "$signature_work/cache" \
  runtime/local/verify-runtime.swift -o "$signature_work/rat-runtime-verifier"
python3 testing/local-runtime/native-signatures/fixtures.py \
  --verifier "$signature_work/rat-runtime-verifier" --output "$signature_work/evidence"
npx vitest run tests/adapters/local-native-verifier.test.ts --no-cache
```

Read the final JSON line for the result. `evidence/latest-run.txt` names the directory containing `results.json` and `commands.json`. Every accepted fixture must return the exact manifest bytes and all five executable paths.

The suite preserves the complete Codex package at `Contents/Resources/codex`. Its descriptor stays beside `bin`, `codex-path`, and `codex-resources`. The VM helper stays at `Contents/Helpers/rat-native-worker`. The outer `Runtime.bundle` uses `CFBundlePackageType=BNDL` without `CFBundleExecutable`.

Treat the generated signatures as test evidence only. Release composition must provide a verifier owned by the signed desktop and outside the candidate bundle. The adapter accepts no manifest-selected or environment-selected verifier path. The installer must authenticate again after copying, decode the returned manifest, match its executable inventory and roles, and hash every payload.

The verifier bounds enumeration before Security.framework runs. Its ceilings are 4,096 entries, 768 MiB per file, 2 GiB total, 128 KiB for the manifest, 32 path components, and 1,024 relative path bytes. `Info.plist` is limited to 64 KiB. Each of the four fixed signature metadata files is limited to 4 MiB. Callers can lower these limits. The subprocess deadline is at most 60 seconds.

Keep the candidate under private, quiescent ancestry throughout verification and selection. These checks do not protect against concurrent mutation by another process with the same UID. They also do not establish notarization, Gatekeeper acceptance, online revocation status, or VM readiness. The team-negative control changes the fixed requirement against the available identity. It does not replace a test with a real foreign-team Developer ID signature.

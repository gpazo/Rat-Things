# JavaScript notice inputs

The native builders collect original legal texts for every package owner recorded
while esbuild loads the installed services or guest worker. Discovery includes
nested vendored LICENSE, LICENCE, COPYING, NOTICE, COPYRIGHT and AUTHORS files,
legal-text directories, explicit `SEE LICENSE IN` metadata and local Markdown
links in collected texts. It does not infer arbitrary prose references or fetch
external links. A license expression alone is not a license payload.

`javascript-supplements.json` records reviewed omissions in published packages.
Each entry binds a package path, name, version and lock integrity to exact upstream
text bytes and an immutable source revision. `surfaces` limits the supplement to
the app or worker inventory that uses it. Unused entries for the selected surface,
stale identities, missing references and changed text fail assembly. Evidence
files are included unchanged beside the collected texts.

The AWS SDK supplement maps three published package versions to the publisher's
v3.1150.0 release asset's package list and immutable source revision. Its provenance record explains the
checks and their limits. This is publisher version/source correspondence; it is
not a cryptographic build attestation for the npm tarballs. The full original
SDK license includes the AWS copyright notice.

The Pi supplement retains the root MIT text for the three 1.3.0 packages whose
published archives omit it. Its provenance binds the lock identities to matching
package names, versions, and license declarations at the publisher's immutable
release commit. This is source correspondence, not an npm build attestation.

Generated numeric filenames avoid deriving output paths from package names. The
index retains each package identity, original path, byte count, hash and explicit
reference relationship. Builders recheck input bytes and directory membership
before completion. Native guest locks include the index hash, and release
assembly streams the actual gzip/newc archive to check every recorded member's
bytes, hashes and metadata before checking notice membership and permissions.
The compressed archive identity is checked during that same read. Both builders
also compare staged files with their admitted identities before establishing the
sealing baseline, and reject unexpected payload changes after signing.

These inputs cover JavaScript notice payloads. Native dependencies, copied
companions, corresponding source archives, and distribution acceptance have
separate records and gates. A collected index does not mark an artifact ready for
public distribution.

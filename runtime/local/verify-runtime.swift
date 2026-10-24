import Darwin
import Foundation
import Security

struct Limits {
    let entries: Int
    let fileBytes: Int
    let totalBytes: Int
    let manifestBytes: Int
    let depth: Int
    let pathBytes: Int

    static let ceiling = Limits(entries: 4096, fileBytes: 768 * 1024 * 1024,
                                totalBytes: 2 * 1024 * 1024 * 1024, manifestBytes: 128 * 1024,
                                depth: 32, pathBytes: 1024)

    init(entries: Int, fileBytes: Int, totalBytes: Int, manifestBytes: Int, depth: Int, pathBytes: Int) {
        self.entries = entries
        self.fileBytes = fileBytes
        self.totalBytes = totalBytes
        self.manifestBytes = manifestBytes
        self.depth = depth
        self.pathBytes = pathBytes
    }

    init(arguments: [String]) throws {
        let ceilings = [Self.ceiling.entries, Self.ceiling.fileBytes, Self.ceiling.totalBytes,
                        Self.ceiling.manifestBytes, Self.ceiling.depth, Self.ceiling.pathBytes]
        let values = try zip(arguments, ceilings).map { value, ceiling -> Int in
            guard !value.isEmpty, value.utf8.count <= 16,
                  value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let number = Int(value), number > 0 else {
                throw Rejection("arguments")
            }
            return min(number, ceiling)
        }
        guard values.count == 6, values[3] <= values[1], values[1] <= values[2] else {
            throw Rejection("arguments")
        }
        self.init(entries: values[0], fileBytes: values[1], totalBytes: values[2],
                  manifestBytes: values[3], depth: values[4], pathBytes: values[5])
    }
}

struct ExecutablePolicy {
    let path: String
    let identifier: String
}

let executablePolicy = [
    ExecutablePolicy(path: "Contents/Helpers/rat-native-worker", identifier: "dev.rat-things.runtime.vm-helper"),
    ExecutablePolicy(path: "Contents/Resources/codex/bin/codex", identifier: "dev.rat-things.runtime.codex"),
    ExecutablePolicy(path: "Contents/Resources/codex/bin/codex-code-mode-host", identifier: "dev.rat-things.runtime.code-mode-host"),
    ExecutablePolicy(path: "Contents/Resources/codex/codex-path/rg", identifier: "dev.rat-things.runtime.ripgrep"),
    ExecutablePolicy(path: "Contents/Resources/codex/codex-resources/zsh/bin/zsh", identifier: "dev.rat-things.runtime.zsh")
]
let executablePaths = Set(executablePolicy.map(\.path))
let signaturePaths: Set<String> = [
    "Contents/_CodeSignature/CodeDirectory", "Contents/_CodeSignature/CodeRequirements",
    "Contents/_CodeSignature/CodeResources", "Contents/_CodeSignature/CodeSignature"
]
let manifestPath = "Contents/Resources/runtime-manifest.json"
let team = "PB8NAVKU57"
let bundleIdentifier = "dev.rat-things.runtime"
let signatureFlags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
let noNetwork = SecCSFlags.noNetworkAccess

struct Rejection: Error {
    let stage: String
    let scope: String
    let reason: String
    let path: String?
    let status: OSStatus?

    init(_ stage: String, scope: String = "bundle", reason: String = "invalid", path: String? = nil, status: OSStatus? = nil) {
        self.stage = stage
        self.scope = scope
        self.reason = reason
        self.path = path
        self.status = status
    }

    var output: [String: Any] {
        var failure: [String: Any] = ["kind": "signature", "scope": scope, "reason": reason]
        if let path { failure["path"] = path }
        if let status { failure["osStatus"] = status }
        return ["schemaVersion": 1, "kind": "rejected", "stage": stage, "failure": failure]
    }
}

func requirement(_ identifier: String) -> String {
    "anchor apple generic and identifier \"\(identifier)\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\""
}

func rejectionReason(_ code: SecStaticCode, identifier: String, status: OSStatus) -> String {
    if status == errSecCSUnsigned { return "unsigned" }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [String: Any] else { return "invalid" }
    guard let actualIdentifier = values[kSecCodeInfoIdentifier as String] as? String else { return "unsigned" }
    if let flags = values[kSecCodeInfoFlags as String] as? NSNumber,
       flags.uint32Value & SecCodeSignatureFlags.adhoc.rawValue != 0 { return "ad_hoc" }
    if let actualTeam = values[kSecCodeInfoTeamIdentifier as String] as? String, actualTeam != team { return "wrong_team" }
    if actualIdentifier != identifier { return "wrong_identifier" }
    return "invalid"
}

func verifySignature(_ url: URL, identifier: String, path: String? = nil) throws {
    let scope = path == nil ? "bundle" : "executable"
    let stage = path == nil ? "bundle-signature" : "executable-signature"
    var code: SecStaticCode?
    let created = SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(rawValue: 0), &code)
    guard created == errSecSuccess, let code else {
        throw Rejection(stage, scope: scope, reason: created == errSecCSUnsigned ? "unsigned" : "invalid", path: path, status: created)
    }
    var expected: SecRequirement?
    guard SecRequirementCreateWithString(requirement(identifier) as CFString, SecCSFlags(rawValue: 0), &expected) == errSecSuccess,
          let expected else { throw Rejection(stage, scope: scope, path: path) }
    var error: Unmanaged<CFError>?
    let status = SecStaticCodeCheckValidityWithErrors(code, signatureFlags.union(noNetwork), expected, &error)
    _ = error?.takeRetainedValue()
    guard status == errSecSuccess else {
        throw Rejection(stage, scope: scope, reason: rejectionReason(code, identifier: identifier, status: status), path: path, status: status)
    }
}

func safeComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && value.utf8.count <= 255
        && value.utf8.elementsEqual(value.precomposedStringWithCanonicalMapping.utf8)
        && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 || "/\\:".unicodeScalars.contains($0) }
}

func fileInfo(_ descriptor: Int32) throws -> stat {
    var info = stat()
    guard fstat(descriptor, &info) == 0 else { throw Rejection("filesystem") }
    return info
}

func openItem(_ parent: Int32, _ name: String, directory: Bool) throws -> Int32 {
    let descriptor = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (directory ? O_DIRECTORY : 0))
    guard descriptor >= 0 else { throw Rejection("filesystem") }
    return descriptor
}

func sameFile(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_mode == right.st_mode
        && left.st_size == right.st_size && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec
        && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec && left.st_nlink == right.st_nlink
        && left.st_uid == right.st_uid && left.st_gid == right.st_gid
        && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
}

func isMachO(_ descriptor: Int32) throws -> Bool {
    var bytes = [UInt8](repeating: 0, count: 4)
    let count = read(descriptor, &bytes, bytes.count)
    guard count >= 0 else { throw Rejection("filesystem") }
    guard count == 4 else { return false }
    let magic = bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].contains(magic)
}

struct Inventory {
    var entries = 1
    var bytes = 0
    var paths = Set<String>()
    var files = Set<String>()
    var executables = Set<String>()
    var manifest: stat?
    var infoPlist: stat?
}

func inspectDirectory(_ descriptor: Int32, prefix: String, device: dev_t, limits: Limits, inventory: inout Inventory) throws {
    let copy = dup(descriptor)
    guard copy >= 0 else { throw Rejection("filesystem") }
    guard let directory = fdopendir(copy) else { close(copy); throw Rejection("filesystem") }
    defer { closedir(directory) }
    while true {
        errno = 0
        guard let entry = readdir(directory) else {
            if errno != 0 { throw Rejection("filesystem") }
            break
        }
        let name = withUnsafeBytes(of: entry.pointee.d_name) { bytes in
            String(bytes: bytes.prefix(Int(entry.pointee.d_namlen)), encoding: .utf8)
        }
        guard let name else { throw Rejection("filesystem") }
        if name == "." || name == ".." { continue }
        guard safeComponent(name) else { throw Rejection("filesystem") }
        let path = prefix.isEmpty ? name : prefix + "/" + name
        inventory.entries += 1
        guard inventory.entries <= limits.entries, path.utf8.count <= limits.pathBytes,
              path.split(separator: "/").count <= limits.depth else { throw Rejection("bounds") }
        guard inventory.paths.insert(path.lowercased()).inserted else { throw Rejection("filesystem") }
        var info = stat()
        guard fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
              info.st_dev == device, (info.st_uid == 0 || info.st_uid == getuid()), info.st_mode & 0o7022 == 0 else { throw Rejection("filesystem") }
        if path.hasPrefix("Contents/_CodeSignature/") && !signaturePaths.contains(path) { throw Rejection("filesystem") }
        let kind = info.st_mode & S_IFMT
        guard kind == S_IFDIR || kind == S_IFREG else { throw Rejection("filesystem") }
        let child = try openItem(descriptor, name, directory: kind == S_IFDIR)
        defer { close(child) }
        guard sameFile(info, try fileInfo(child)) else { throw Rejection("filesystem") }
        if kind == S_IFDIR {
            if prefix.isEmpty && name != "Contents" { throw Rejection("filesystem") }
            try inspectDirectory(child, prefix: path, device: device, limits: limits, inventory: &inventory)
            continue
        }
        guard path.hasPrefix("Contents/"), info.st_nlink == 1 else { throw Rejection("filesystem") }
        guard info.st_size >= 0, info.st_size <= limits.fileBytes,
              inventory.bytes <= limits.totalBytes - Int(info.st_size) else { throw Rejection("bounds") }
        inventory.bytes += Int(info.st_size)
        inventory.files.insert(path)
        if signaturePaths.contains(path) && info.st_size > 4 * 1024 * 1024 { throw Rejection("bounds") }
        if path == "Contents/Info.plist" {
            guard info.st_size <= 64 * 1024 else { throw Rejection("bounds") }
            inventory.infoPlist = info
        }
        if path == manifestPath {
            guard info.st_size <= limits.manifestBytes else { throw Rejection("bounds") }
            inventory.manifest = info
        }
        let executable = info.st_mode & 0o111 != 0
        let machO = path == manifestPath ? false : try isMachO(child)
        if executable || machO || executablePaths.contains(path) {
            guard executablePaths.contains(path), executable, machO else { throw Rejection("filesystem") }
            inventory.executables.insert(path)
        }
    }
}

func readResource(_ descriptor: Int32, name: String, resourcesDirectory: Bool, expected: stat, limit: Int) throws -> Data {
    let contents = try openItem(descriptor, "Contents", directory: true)
    defer { close(contents) }
    let parent = resourcesDirectory ? try openItem(contents, "Resources", directory: true) : dup(contents)
    guard parent >= 0 else { throw Rejection("filesystem") }
    defer { close(parent) }
    let file = try openItem(parent, name, directory: false)
    defer { close(file) }
    guard sameFile(expected, try fileInfo(file)) else { throw Rejection("manifest") }
    var data = Data()
    var bytes = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = read(file, &bytes, min(bytes.count, limit + 1 - data.count))
        guard count >= 0 else { throw Rejection("manifest") }
        if count == 0 { break }
        data.append(contentsOf: bytes.prefix(count))
        guard data.count <= limit else { throw Rejection("bounds") }
    }
    guard data.count == expected.st_size, sameFile(expected, try fileInfo(file)) else { throw Rejection("manifest") }
    return data
}

func verify(arguments: [String]) throws -> [String: Any] {
    guard arguments.count == 9, arguments[1] == "verify-runtime" else { throw Rejection("arguments") }
    let path = arguments[2]
    guard path.hasPrefix("/"), path.utf8.count <= 4096,
          path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({ safeComponent(String($0)) }) else {
        throw Rejection("arguments")
    }
    let limits = try Limits(arguments: Array(arguments.dropFirst(3)))
    let root = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard root >= 0 else { throw Rejection("filesystem") }
    defer { close(root) }
    let rootInfo = try fileInfo(root)
    guard (rootInfo.st_uid == 0 || rootInfo.st_uid == getuid()), rootInfo.st_mode & 0o7022 == 0 else { throw Rejection("filesystem") }
    var inventory = Inventory()
    try inspectDirectory(root, prefix: "", device: rootInfo.st_dev, limits: limits, inventory: &inventory)
    guard inventory.executables == executablePaths, signaturePaths.isSubset(of: inventory.files),
          let infoPlist = inventory.infoPlist, let manifest = inventory.manifest else { throw Rejection("filesystem") }
    let url = URL(fileURLWithPath: path, isDirectory: true)
    try verifySignature(url, identifier: bundleIdentifier)
    for executable in executablePolicy {
        try verifySignature(url.appendingPathComponent(executable.path), identifier: executable.identifier, path: executable.path)
    }
    let metadata = try readResource(root, name: "Info.plist", resourcesDirectory: false, expected: infoPlist, limit: 64 * 1024)
    guard let plist = try PropertyListSerialization.propertyList(from: metadata, format: nil) as? [String: Any],
          plist["CFBundlePackageType"] as? String == "BNDL", plist["CFBundleIdentifier"] as? String == bundleIdentifier,
          plist["CFBundleExecutable"] == nil else { throw Rejection("filesystem") }
    let bytes = try readResource(root, name: "runtime-manifest.json", resourcesDirectory: true, expected: manifest, limit: limits.manifestBytes)
    return ["schemaVersion": 1, "kind": "authenticated", "manifestBase64": bytes.base64EncodedString(),
            "executablePaths": executablePolicy.map(\.path)]
}

let output: [String: Any]
let exitCode: Int32
do {
    output = try verify(arguments: CommandLine.arguments)
    exitCode = 0
} catch let rejection as Rejection {
    output = rejection.output
    exitCode = 1
} catch {
    output = Rejection("filesystem").output
    exitCode = 1
}
if let bytes = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data([10]))
}
exit(exitCode)

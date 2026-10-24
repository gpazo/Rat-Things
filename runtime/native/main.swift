import Darwin
import Foundation
import Virtualization

struct BootConfiguration: Decodable {
    let kernel: String
    let initrd: String
    let disk: String
    let serialLog: String
    let workspace: String
    let cpuCount: Int
    let memoryMiB: UInt64
    let device: String
    let inode: String
    let filesystemUUID: String
}

func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { exit(1) }
    FileHandle.standardOutput.write(data + Data([10]))
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return false }
            offset += count
        }
        return true
    }
}

func prepareStream(_ fd: Int32, timeoutMs: Int = 120_000) {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    var timeout = timeval(tv_sec: timeoutMs / 1000, tv_usec: Int32((timeoutMs % 1000) * 1000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
}

func copyStream(_ source: Int32, _ destination: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = Darwin.read(source, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 || !writeAll(destination, Data(buffer.prefix(count))) { break }
    }
    shutdown(destination, SHUT_WR)
}

struct ProbeDiskBinding: Decodable {
    struct Identity: Decodable { let sessionId: String; let generation: String; let setupDigest: String; let version: Int }
    let identity: Identity
    let device: String
    let inode: String
    let filesystemUUID: String
}

func probeFailure() -> NSError { NSError(domain: "rat-native-probe", code: 1) }

func privateProbeDirectory(_ path: String) throws -> Int32 {
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard path.utf8.count <= 4096, components.first == "", components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
          let name = components.last, name.hasPrefix("probe-"), UUID(uuidString: String(name.dropFirst(6))) != nil else { throw probeFailure() }
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw probeFailure() }
    for component in components.dropFirst() {
        let next = openat(descriptor, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        Darwin.close(descriptor)
        guard next >= 0 else { throw probeFailure() }
        descriptor = next
    }
    var state = stat()
    guard fstat(descriptor, &state) == 0, state.st_uid == getuid(), state.st_mode & 0o777 == 0o700 else {
        Darwin.close(descriptor)
        throw probeFailure()
    }
    return descriptor
}

func openProbeDisk(_ directory: Int32) throws -> Int32? {
    let descriptor = openat(directory, "workspace.raw", O_RDWR | O_NOFOLLOW)
    if descriptor < 0 && errno == ENOENT { return nil }
    guard descriptor >= 0 else { throw probeFailure() }
    do {
        var state = stat()
        guard fstat(descriptor, &state) == 0, state.st_mode & S_IFMT == S_IFREG, state.st_nlink == 1,
              state.st_uid == getuid(), state.st_mode & 0o777 == 0o600,
              state.st_size >= 0, state.st_size <= 256 * 1024 * 1024 else { throw probeFailure() }
        let receipt = openat(directory, "binding.json", O_RDONLY | O_NOFOLLOW)
        guard receipt >= 0 else { throw probeFailure() }
        defer { Darwin.close(receipt) }
        var receiptState = stat()
        guard fstat(receipt, &receiptState) == 0, receiptState.st_mode & S_IFMT == S_IFREG,
              receiptState.st_nlink == 1, receiptState.st_uid == getuid(), receiptState.st_mode & 0o777 == 0o600,
              receiptState.st_size > 0, receiptState.st_size <= 4096 else { throw probeFailure() }
        let bytes = try FileHandle(fileDescriptor: receipt, closeOnDealloc: false).read(upToCount: 4097) ?? Data()
        guard bytes.count == Int(receiptState.st_size) else { throw probeFailure() }
        let binding = try JSONDecoder().decode(ProbeDiskBinding.self, from: bytes)
        guard binding.device == String(state.st_dev), binding.inode == String(state.st_ino), binding.identity.version == 1,
              binding.identity.sessionId.range(of: "^sess_probe[a-f0-9]{32}$", options: .regularExpression) != nil,
              binding.identity.setupDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              UUID(uuidString: binding.identity.generation) != nil, UUID(uuidString: binding.filesystemUUID) != nil else { throw probeFailure() }
        return descriptor
    } catch { Darwin.close(descriptor); throw error }
}

func diskStillNamed(_ descriptor: Int32, directory: Int32, name: String) -> Bool {
    var opened = stat()
    var named = stat()
    return fstat(descriptor, &opened) == 0 && fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0
        && opened.st_dev == named.st_dev && opened.st_ino == named.st_ino
        && opened.st_nlink == 1 && named.st_mode & S_IFMT == S_IFREG
}

func disposeProbeDisk(_ path: String) {
    do {
        let directory = try privateProbeDirectory(path)
        defer { Darwin.close(directory) }
        guard let disk = try openProbeDisk(directory) else { emit(["schemaVersion": 1, "status": "absent"]); exit(0) }
        defer { Darwin.close(disk) }
        guard flock(disk, LOCK_EX | LOCK_NB) == 0 else {
            if errno == EWOULDBLOCK { emit(["schemaVersion": 1, "status": "locked"]); exit(2) }
            throw probeFailure()
        }
        guard diskStillNamed(disk, directory: directory, name: "workspace.raw"),
              unlinkat(directory, "workspace.raw", 0) == 0, fsync(directory) == 0 else { throw probeFailure() }
        emit(["schemaVersion": 1, "status": "disposed"])
        exit(0)
    } catch { emit(["schemaVersion": 1, "status": "invalid"]); exit(1) }
}

func controllerInput(_ receive: @escaping (Data) -> Void) {
    var pending = Data()
    var bytes = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { exit(1) }
        pending.append(contentsOf: bytes.prefix(count))
        while let newline = pending.firstIndex(of: 10) {
            guard newline < 8 * 1024 * 1024 else { exit(1) }
            let line = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            receive(line)
        }
        if pending.count > 8 * 1024 * 1024 { exit(1) }
    }
}

final class BoundedSerialLog {
    let pipe = Pipe()
    let destination: Int32
    let source: DispatchSourceRead
    var written = 0

    init(_ path: String) throws {
        destination = Darwin.open(path, O_WRONLY | O_NOFOLLOW)
        var state = stat()
        guard destination >= 0, fstat(destination, &state) == 0, state.st_mode & S_IFMT == S_IFREG,
              state.st_nlink == 1, state.st_uid == getuid(), state.st_size == 0 else { throw probeFailure() }
        source = DispatchSource.makeReadSource(fileDescriptor: pipe.fileHandleForReading.fileDescriptor,
            queue: DispatchQueue(label: "rat-native-serial"))
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            var bytes = [UInt8](repeating: 0, count: 65536)
            let count = Darwin.read(self.pipe.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count <= 0 { return }
            let permitted = min(count, 1024 * 1024 - self.written)
            if permitted > 0 {
                if !writeAll(self.destination, Data(bytes.prefix(permitted))) { exit(1) }
                self.written += permitted
            }
        }
        source.resume()
    }
}

final class Runtime: NSObject, VZVirtualMachineDelegate {
    let vm: VZVirtualMachine
    let listener: Int32
    let port: UInt16
    let diskDescriptor: Int32
    let serialLog: BoundedSerialLog
    var source: DispatchSourceRead?
    var bridges: [UUID: (Int32, VZVirtioSocketConnection)] = [:]
    var pending = 0
    var controlling = false

    init(_ input: BootConfiguration) throws {
        guard VZVirtualMachine.isSupported, input.cpuCount == 1,
              (1536...3072).contains(input.memoryMiB), ["fresh", "existing", "readonly"].contains(input.workspace),
              UUID(uuidString: input.filesystemUUID) != nil else {
            throw NSError(domain: "rat-native-worker", code: 1)
        }
        let configuration = VZVirtualMachineConfiguration()
        diskDescriptor = Darwin.open(input.disk, (input.workspace == "readonly" ? O_RDONLY : O_RDWR) | O_NOFOLLOW)
        var diskState = stat()
        guard diskDescriptor >= 0, fstat(diskDescriptor, &diskState) == 0,
              diskState.st_mode & S_IFMT == S_IFREG, diskState.st_nlink == 1,
              String(diskState.st_dev) == input.device, String(diskState.st_ino) == input.inode,
              flock(diskDescriptor, LOCK_EX | LOCK_NB) == 0,
              diskStillNamed(diskDescriptor, directory: AT_FDCWD, name: input.disk) else {
            throw NSError(domain: "rat-native-worker", code: 5)
        }
        let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: input.kernel))
        boot.initialRamdiskURL = URL(fileURLWithPath: input.initrd)
        boot.commandLine = "console=hvc0 oops=panic panic=0 rootfstype=ramfs rat.workspace=\(input.workspace) rat.filesystem=\(input.filesystemUUID)"
        configuration.bootLoader = boot
        configuration.platform = VZGenericPlatformConfiguration()
        configuration.cpuCount = input.cpuCount
        configuration.memorySize = input.memoryMiB * 1024 * 1024
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment:
            try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: "/dev/fd/\(diskDescriptor)"), readOnly: input.workspace == "readonly"))]
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serialLog = try BoundedSerialLog(input.serialLog)
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil,
            fileHandleForWriting: serialLog.pipe.fileHandleForWriting)
        configuration.serialPorts = [serial]
        configuration.networkDevices = []
        try configuration.validate()
        vm = VZVirtualMachine(configuration: configuration)
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        listener = descriptor
        guard descriptor >= 0 else { throw NSError(domain: "rat-native-worker", code: 2) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(listener, 64) == 0 else { Darwin.close(listener); throw NSError(domain: "rat-native-worker", code: 3) }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
        }
        guard named == 0 else { Darwin.close(listener); throw NSError(domain: "rat-native-worker", code: 4) }
        port = UInt16(bigEndian: address.sin_port)
        super.init()
        vm.delegate = self
        _ = fcntl(listener, F_SETFL, O_NONBLOCK)
        source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: .main)
        source?.setEventHandler { [weak self] in self?.acceptConnections() }
        source?.resume()
    }

    var sockets: VZVirtioSocketDevice { vm.socketDevices[0] as! VZVirtioSocketDevice }

    func acceptConnections() {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 { return }
            guard bridges.count + pending < 64, vm.state == .running else { Darwin.close(fd); continue }
            pending += 1
            sockets.connect(toPort: 7000) { result in
                self.pending -= 1
                guard case .success(let connection) = result else { Darwin.close(fd); return }
                let id = UUID()
                self.bridges[id] = (fd, connection)
                prepareStream(fd)
                prepareStream(connection.fileDescriptor)
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { copyStream(fd, connection.fileDescriptor); group.leave() }
                group.enter()
                DispatchQueue.global().async { copyStream(connection.fileDescriptor, fd); group.leave() }
                group.notify(queue: .main) {
                    shutdown(fd, SHUT_RDWR)
                    Darwin.close(fd)
                    connection.close()
                    self.bridges.removeValue(forKey: id)
                }
            }
        }
    }

    func control(_ data: Data) {
        guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? Int else { emit(["status": "invalid_control"]); return }
        let timeoutMs = (request["timeoutMs"] as? Int) ?? (request["timeoutMs"] == nil ? 90_000 : 0)
        guard timeoutMs > 0 else { emit(["id": id, "error": "Invalid control deadline"]); return }
        guard !controlling, vm.state == .running else { emit(["id": id, "error": "Native VM is not ready"]); return }
        controlling = true
        sockets.connect(toPort: 7001) { result in
            guard case .success(let connection) = result else {
                self.controlling = false
                emit(["id": id, "error": "Native guest control is unavailable"])
                return
            }
            DispatchQueue.global().async {
                prepareStream(connection.fileDescriptor, timeoutMs: max(120_000, timeoutMs))
                var reply = Data()
                var buffer = [UInt8](repeating: 0, count: 65536)
                if writeAll(connection.fileDescriptor, data + Data([10])) {
                    while reply.count <= 150 * 1024 * 1024 {
                        let count = Darwin.read(connection.fileDescriptor, &buffer, buffer.count)
                        if count < 0 && errno == EINTR { continue }
                        if count <= 0 { break }
                        reply.append(contentsOf: buffer.prefix(count))
                        if reply.last == 10 { break }
                    }
                }
                let response = reply.count <= 150 * 1024 * 1024 ? (try? JSONSerialization.jsonObject(with: reply)) as? [String: Any] : nil
                DispatchQueue.main.async {
                    connection.close()
                    self.controlling = false
                    var message = response ?? ["error": "Invalid native guest response"]
                    message["id"] = id
                    emit(message)
                    if request["operation"] as? String == "stop", message["error"] == nil {
                        self.vm.stop { error in
                            emit(["status": error == nil ? "stopped" : "failed"])
                            exit(error == nil ? 0 : 1)
                        }
                    }
                }
            }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        emit(["status": "stopped"])
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        emit(["status": "failed"])
        exit(1)
    }
}

func hostFacts() {
    var pressure: UInt32 = 0
    var length = MemoryLayout<UInt32>.size
    let result = sysctlbyname("kern.memorystatus_vm_pressure_level", &pressure, &length, nil, 0)
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "unsupported"
    #endif
    emit(["supported": VZVirtualMachine.isSupported, "architecture": architecture,
          "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory,
          "minimumCPUCount": VZVirtualMachineConfiguration.minimumAllowedCPUCount,
          "maximumCPUCount": VZVirtualMachineConfiguration.maximumAllowedCPUCount,
          "minimumMemoryBytes": VZVirtualMachineConfiguration.minimumAllowedMemorySize,
          "maximumMemoryBytes": VZVirtualMachineConfiguration.maximumAllowedMemorySize,
          "memoryPressure": result == 0 && length == MemoryLayout<UInt32>.size ? pressure : 0])
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--dispose-probe-disk" {
    disposeProbeDisk(CommandLine.arguments[2])
}

#if NATIVE_PROBE_TEST_FIXTURE
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--serial-log-fixture" {
    do {
        let log = try BoundedSerialLog(CommandLine.arguments[2])
        withExtendedLifetime(log) {
            let chunk = Data(repeating: 72, count: 65536)
            for _ in 0..<32 { if !writeAll(log.pipe.fileHandleForWriting.fileDescriptor, chunk) { exit(1) } }
            if fsync(log.destination) != 0 { exit(1) }
            emit(["status": "written"])
        }
        exit(0)
    } catch { exit(1) }
}
if CommandLine.arguments.count == 3 && ["--hold-probe-disk", "--defer-probe-lock"].contains(CommandLine.arguments[1]) {
    do {
        let directory = try privateProbeDirectory(CommandLine.arguments[2])
        guard let disk = try openProbeDisk(directory) else { throw probeFailure() }
        if CommandLine.arguments[1] == "--defer-probe-lock" {
            emit(["status": "opened"])
            var byte: UInt8 = 0
            guard Darwin.read(STDIN_FILENO, &byte, 1) == 1 else { exit(1) }
        }
        guard flock(disk, LOCK_EX | LOCK_NB) == 0, diskStillNamed(disk, directory: directory, name: "workspace.raw") else { throw probeFailure() }
        emit(["status": "locked"])
        controllerInput { _ in }
    } catch { exit(1) }
}
#endif

if CommandLine.arguments == [CommandLine.arguments[0], "--host-facts"] {
    hostFacts()
    exit(0)
}

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "rat-native-worker", code: 5) }
    let input = try JSONDecoder().decode(BootConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    signal(SIGPIPE, SIG_IGN)
    let runtime = try Runtime(input)
    runtime.vm.start { result in
        switch result {
        case .success: emit(["status": "started", "relayPort": runtime.port])
        case .failure: emit(["status": "failed"]); exit(1)
        }
    }
    DispatchQueue.global().async {
        controllerInput { line in DispatchQueue.main.async { runtime.control(line) } }
    }
    withExtendedLifetime(runtime) { RunLoop.main.run() }
} catch {
    emit(["status": "invalid_configuration"])
    exit(1)
}

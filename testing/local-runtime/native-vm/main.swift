import Foundation
import Virtualization

struct BootConfiguration: Decodable {
    let kernel: String
    let initrd: String
    let disk: String
    let serialLog: String
    let cpuCount: Int
    let memoryMiB: UInt64
}

func event(_ status: String, detail: String? = nil) {
    var message = ["status": status]
    if let detail { message["detail"] = detail }
    let data = try! JSONSerialization.data(withJSONObject: message)
    FileHandle.standardOutput.write(data + Data([10]))
}

final class Lifecycle: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        event("stopped")
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        event("failed", detail: error.localizedDescription)
        exit(1)
    }
}

do {
    guard CommandLine.arguments.count == 2 else {
        throw NSError(domain: "rat-vm-prototype", code: 1)
    }
    let input = try JSONDecoder().decode(BootConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    guard VZVirtualMachine.isSupported, (1...2).contains(input.cpuCount), (128...512).contains(input.memoryMiB) else {
        throw NSError(domain: "rat-vm-prototype", code: 2)
    }
    let configuration = VZVirtualMachineConfiguration()
    let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: input.kernel))
    boot.initialRamdiskURL = URL(fileURLWithPath: input.initrd)
    boot.commandLine = "console=hvc0 quiet panic=-1"
    configuration.bootLoader = boot
    configuration.platform = VZGenericPlatformConfiguration()
    configuration.cpuCount = input.cpuCount
    configuration.memorySize = input.memoryMiB * 1024 * 1024
    configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment:
        try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: input.disk), readOnly: false))]
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil,
        fileHandleForWriting: try FileHandle(forWritingTo: URL(fileURLWithPath: input.serialLog)))
    configuration.serialPorts = [serial]
    configuration.networkDevices = []
    try configuration.validate()
    let vm = VZVirtualMachine(configuration: configuration)
    let lifecycle = Lifecycle()
    vm.delegate = lifecycle
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let stop = {
        vm.stop { error in
            event(error == nil ? "stopped" : "failed")
            exit(error == nil ? 0 : 1)
        }
    }
    termination.setEventHandler(handler: stop)
    interrupt.setEventHandler(handler: stop)
    termination.resume()
    interrupt.resume()
    vm.start { result in
        switch result {
        case .success: event("started")
        case .failure(let error): event("failed", detail: error.localizedDescription); exit(1)
        }
    }
    withExtendedLifetime((vm, lifecycle, termination, interrupt)) { RunLoop.main.run() }
} catch {
    event("invalid_configuration", detail: error.localizedDescription)
    exit(1)
}

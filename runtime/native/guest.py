import fcntl
import http.client
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading

MAX_REQUEST = 8 * 1024 * 1024
MAX_RESPONSE = 150 * 1024 * 1024
worker = None
control_lock = threading.Lock()
relay_slots = threading.BoundedSemaphore(64)
readonly = False


def stop_worker(process):
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            pass
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)


def worker_ready():
    if worker is None or worker.poll() is not None:
        return False
    connection = http.client.HTTPConnection("127.0.0.1", 3211, timeout=3)
    try:
        connection.request("GET", "/health")
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def handle_control(connection):
    global worker
    with connection, control_lock:
        connection.settimeout(90)
        reader = connection.makefile("rb")
        try:
            line = reader.readline(MAX_REQUEST + 1)
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise ValueError("Invalid control frame")
            request = json.loads(line)
            timeout_ms = request.get("timeoutMs", 90_000)
            if type(timeout_ms) is not int or not 1 <= timeout_ms <= 9007199254740991:
                raise ValueError("Invalid control deadline")
            operation = request["operation"]
            if operation == "ping":
                result = {"ready": True}
            elif operation == "health":
                result = {"ready": worker_ready()}
            elif operation == "start" and not readonly and worker is None:
                worker = subprocess.Popen(
                    ["node", "/opt/rat-things/local-worker.mjs"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=sys.stderr, start_new_session=True,
                )
                worker.stdin.write(json.dumps(request["configuration"]).encode() + b"\n")
                worker.stdin.close()
                timer = threading.Timer(timeout_ms / 1000, lambda: os.killpg(worker.pid, signal.SIGKILL) if worker and worker.poll() is None else None)
                timer.start()
                try:
                    status = json.loads(worker.stdout.readline(4096))
                    if status != {"status": "ready"} or worker.poll() is not None:
                        raise RuntimeError("Worker registration failed")
                finally:
                    timer.cancel()
                result = {"ready": True}
            elif operation == "snapshot" and readonly:
                if not os.statvfs("/workspace").f_flag & os.ST_RDONLY:
                    raise RuntimeError("Snapshot workspace must be read-only")
                exported = subprocess.run(
                    ["node", "/opt/rat-things/export-workspace.cjs"],
                    capture_output=True, timeout=60, check=True,
                    user=10001, group=10001,
                ).stdout
                if len(exported) > MAX_RESPONSE:
                    raise ValueError("Snapshot exceeds transport limit")
                result = json.loads(exported)
            elif operation == "stop":
                worker = stop_worker(worker)
                os.sync()
                subprocess.run(["umount", "/workspace"], check=True, timeout=10, capture_output=True)
                subprocess.run(["umount", "/var/lib/rat-things/workspace"], check=True, timeout=10, capture_output=True)
                subprocess.run(["umount", "/mnt/rat-disk"], check=True, timeout=10, capture_output=True)
                result = {"stopped": True}
            else:
                raise ValueError("Invalid control operation")
            response = {"result": result}
        except Exception as error:
            print("RAT_NATIVE_CONTROL_FAILED " + type(error).__name__, flush=True)
            worker = stop_worker(worker)
            response = {"error": "Native guest control operation failed"}
        connection.sendall(json.dumps(response, separators=(",", ":")).encode() + b"\n")
        reader.close()


def copy_stream(source, destination):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_relay(connection):
    try:
        with connection, socket.create_connection(("127.0.0.1", 3211), timeout=120) as target:
            connection.settimeout(120)
            outbound = threading.Thread(target=copy_stream, args=(connection, target), daemon=True)
            outbound.start()
            copy_stream(target, connection)
            outbound.join(timeout=125)
    except OSError:
        pass
    finally:
        relay_slots.release()


def serve(port, handler):
    listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    listener.bind((socket.VMADDR_CID_ANY, port))
    listener.listen(64)
    while True:
        connection, address = listener.accept()
        if address[0] != socket.VMADDR_CID_HOST:
            connection.close()
            continue
        if port == 7000 and not relay_slots.acquire(blocking=False):
            connection.close()
            continue
        threading.Thread(target=handler, args=(connection,), daemon=True).start()


if __name__ == "__main__":
    readonly = "rat.workspace=readonly" in open("/proc/cmdline").read().split()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as loopback:
        fcntl.ioctl(loopback, 0x8914, struct.pack("16sh", b"lo", 0x49))
    threading.Thread(target=serve, args=(7000, handle_relay), daemon=True).start()
    print("RAT_NATIVE_CONTROL_READY", flush=True)
    serve(7001, handle_control)

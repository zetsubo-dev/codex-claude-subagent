#!/usr/bin/env python3
import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


MAX_PENDING_BYTES = 4 * 1024 * 1024
IO_CHUNK_BYTES = 64 * 1024
STOP_DRAIN_SECONDS = 2.0


def main():
    parser = argparse.ArgumentParser(description="Bridge a child process through a pseudo-terminal.")
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
      command = command[1:]
    if not command:
        print("pty_bridge.py: missing command", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, args.rows, args.cols)
    set_nonblocking(master_fd)
    set_nonblocking(sys.stdin.fileno())
    set_nonblocking(sys.stdout.fileno())

    child = subprocess.Popen(
        command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    stdin_open = True
    master_open = True
    stop_requested = False
    stop_deadline = None
    pending_to_child = bytearray()
    pending_to_parent = bytearray()

    def request_stop(_signum, _frame):
        nonlocal stop_requested, stop_deadline
        stop_requested = True
        stop_deadline = time.monotonic() + STOP_DRAIN_SECONDS
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGHUP, request_stop)

    try:
        while True:
            if stop_requested and stop_deadline is not None and time.monotonic() >= stop_deadline:
                break

            child_exited = child.poll() is not None
            if child_exited:
                pending_to_child.clear()

            read_fds = []
            if master_open and len(pending_to_parent) < MAX_PENDING_BYTES:
                read_fds.append(master_fd)
            if stdin_open and not stop_requested and not child_exited and len(pending_to_child) < MAX_PENDING_BYTES:
                read_fds.append(sys.stdin.fileno())
            write_fds = []
            if pending_to_child and master_open and not child_exited:
                write_fds.append(master_fd)
            if pending_to_parent:
                write_fds.append(sys.stdout.fileno())

            if child_exited and not master_open and not pending_to_parent:
                break

            try:
                readable, writable, _ = select.select(read_fds, write_fds, [], 0.1)
            except InterruptedError:
                continue

            if master_fd in readable:
                try:
                    data = os.read(master_fd, IO_CHUNK_BYTES)
                except BlockingIOError:
                    data = None
                except OSError:
                    data = b""
                if data:
                    pending_to_parent.extend(data)
                elif data == b"":
                    master_open = False

            if stdin_open and sys.stdin.fileno() in readable:
                try:
                    data = os.read(sys.stdin.fileno(), IO_CHUNK_BYTES)
                except BlockingIOError:
                    data = None
                if data:
                    pending_to_child.extend(data)
                elif data == b"":
                    stdin_open = False
                    request_stop(None, None)

            if master_fd in writable and pending_to_child:
                try:
                    written = os.write(master_fd, pending_to_child[:IO_CHUNK_BYTES])
                    if written > 0:
                        del pending_to_child[:written]
                except (BlockingIOError, InterruptedError):
                    pass
                except OSError:
                    master_open = False
                    pending_to_child.clear()

            if sys.stdout.fileno() in writable and pending_to_parent:
                try:
                    written = os.write(sys.stdout.fileno(), pending_to_parent[:IO_CHUNK_BYTES])
                    if written > 0:
                        del pending_to_parent[:written]
                except (BlockingIOError, InterruptedError):
                    pass
                except OSError:
                    request_stop(None, None)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    pass
        return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())

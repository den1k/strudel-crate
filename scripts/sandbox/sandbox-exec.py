#!/usr/bin/python3 -I
"""Exec a command under a kernel-enforced, unprivileged sandbox for this process tree.

Host constraint: no bwrap/firejail, unprivileged user namespaces are blocked by AppArmor,
and `systemd-run --user` silently ignores mount-namespace options such as InaccessiblePaths.
Landlock (filesystem + TCP port allowlist) and seccomp need no privilege, are inherited by
every descendant and cannot be removed. Fails closed: if any step fails, nothing is exec'd.

usage: sandbox-exec.py [--ro P] [--rox P] [--rw P] [--tcp PORT] [--allow-udp] [--env-file F] -- cmd args...

--env-file replaces the environment with a JSON object read from F and deletes F, which keeps
the job's short-lived credentials off every command line.
"""
import ctypes
import json
import os
import stat
import struct
import sys

EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 2, 4, 8
REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM, REFER, TRUNCATE = (
    16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384)
ALL_FS = (1 << 15) - 1
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE
RO = READ_FILE | READ_DIR
ROX = RO | EXECUTE
RW = RO | WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_DIR | MAKE_REG | MAKE_SYM | MAKE_FIFO | REFER | TRUNCATE
BIND_TCP, CONNECT_TCP = 1, 2
MIN_ABI = 4  # TCP port rules

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 38, 22, 2

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def die(msg):
    sys.stderr.write(f"sandbox-exec: {msg}\n")
    os._exit(125)


def landlock(rules, ports):
    if libc.syscall(SYS_CREATE, None, 0, 1) < MIN_ABI:
        die(f"Landlock ABI >= {MIN_ABI} required")
    attr = ctypes.create_string_buffer(struct.pack("QQ", ALL_FS, BIND_TCP | CONNECT_TCP))
    ruleset = libc.syscall(SYS_CREATE, attr, 16, 0)
    if ruleset < 0:
        die("landlock_create_ruleset failed")
    for path, rights in rules:
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            continue  # an allowlist entry that doesn't exist grants nothing
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            rights &= FILE_RIGHTS
        buf = ctypes.create_string_buffer(struct.pack("<Qi", rights, fd))
        if libc.syscall(SYS_ADD, ruleset, 1, buf, 0) != 0:
            die(f"landlock rule failed for {path}: errno {ctypes.get_errno()}")
        os.close(fd)
    for port in ports:
        buf = ctypes.create_string_buffer(struct.pack("<QQ", CONNECT_TCP, port))
        if libc.syscall(SYS_ADD, ruleset, 2, buf, 0) != 0:
            die(f"landlock port rule failed for {port}")
    if libc.syscall(SYS_RESTRICT, ruleset, 0) != 0:
        die("landlock_restrict_self failed")
    os.close(ruleset)


def seccomp(allow_udp):
    """x86-64 only. Landlock on this kernel can't see UDP or UNIX sockets (a UNIX connect
    to the user bus would be a full escape), and io_uring would sidestep a socket() filter."""
    AUDIT_ARCH_X86_64 = 0xC000003E
    LD_W_ABS, JEQ_K, JGE_K, RET_K, ALU_AND_K = 0x20, 0x15, 0x35, 0x06, 0x54
    LD_ARG0, LD_ARG1 = 16, 24  # low words of seccomp_data.args[0..1]
    ALLOW, DENY_EPERM, DENY_EAFNO, KILL = 0x7FFF0000, 0x00050001, 0x00050061, 0x80000000
    ENOSYS = 0x00050026
    deny = {425: ENOSYS, 426: ENOSYS, 427: ENOSYS,  # io_uring_*
            321: DENY_EPERM, 298: DENY_EPERM, 310: DENY_EPERM, 311: DENY_EPERM,  # bpf perf process_vm_*
            101: DENY_EPERM, 248: DENY_EPERM, 249: DENY_EPERM, 250: DENY_EPERM}  # ptrace, keys
    SOCKET = 41
    prog = [(LD_W_ABS, 0, 0, 4), (JEQ_K, 1, 0, AUDIT_ARCH_X86_64), (RET_K, 0, 0, KILL),
            (LD_W_ABS, 0, 0, 0), (JGE_K, 0, 1, 0x40000000), (RET_K, 0, 0, DENY_EPERM)]
    for nr, action in deny.items():
        prog += [(JEQ_K, 0, 1, nr), (RET_K, 0, 0, action)]
    prog += [(JEQ_K, 1, 0, SOCKET), (RET_K, 0, 0, ALLOW)]
    # socket(): only AF_INET/AF_INET6, and only stream unless UDP was asked for.
    prog += [(LD_W_ABS, 0, 0, LD_ARG0), (JEQ_K, 2, 0, 2), (JEQ_K, 1, 0, 10), (RET_K, 0, 0, DENY_EAFNO),
             (LD_W_ABS, 0, 0, LD_ARG1), (ALU_AND_K, 0, 0, 0xF)]
    prog += [(JEQ_K, 2, 0, 1), (JEQ_K, 1, 0, 2)] if allow_udp else [(JEQ_K, 1, 0, 1)]
    prog += [(RET_K, 0, 0, DENY_EAFNO), (RET_K, 0, 0, ALLOW)]
    filt = b"".join(struct.pack("<HBBI", *ins) for ins in prog)
    buf = ctypes.create_string_buffer(filt)
    fprog = ctypes.create_string_buffer(struct.pack("<H6xQ", len(prog), ctypes.addressof(buf)))
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, fprog, 0, 0) != 0:
        die(f"seccomp failed: errno {ctypes.get_errno()}")


def main(argv):
    rules, ports, allow_udp, env_file, i = [], [], False, None, 0
    while i < len(argv) and argv[i] != "--":
        flag = argv[i]
        if flag == "--allow-udp":
            allow_udp = True
            i += 1
        elif flag in ("--ro", "--rox", "--rw"):
            rules.append((argv[i + 1], {"--ro": RO, "--rox": ROX, "--rw": RW}[flag]))
            i += 2
        elif flag == "--env-file":
            env_file = argv[i + 1]
            i += 2
        elif flag == "--tcp":
            ports.append(int(argv[i + 1]))
            i += 2
        else:
            die(f"unknown flag {flag}")
    cmd = argv[i + 1:]
    if not cmd:
        die("no command")
    env = os.environ
    if env_file:
        with open(env_file) as f:
            env = json.load(f)
        os.unlink(env_file)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die("no_new_privs failed")
    landlock(rules, ports)
    seccomp(allow_udp)
    try:
        os.execvpe(cmd[0], cmd, env)
    except OSError as e:
        die(f"exec {cmd[0]}: {e}")


main(sys.argv[1:])

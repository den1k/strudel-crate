#!/usr/bin/python3 -I
"""Exec a command under a kernel-enforced, unprivileged sandbox for this process tree.

Host constraint: no bwrap/firejail, unprivileged user namespaces are blocked by AppArmor,
and `systemd-run --user` silently ignores mount-namespace options such as InaccessiblePaths.
Landlock (filesystem + TCP port allowlist) and seccomp need no privilege, are inherited by
every descendant and cannot be removed. Fails closed: if any step fails, nothing is exec'd.

usage: sandbox-exec.py [--ro P] [--rox P] [--rw P] [--rw-links P] [--tcp PORT] [--allow-udp] [--env-file F] -- cmd args...

--env-file replaces the environment with a JSON object read from F and deletes F, which keeps
the job's short-lived credentials off every command line.
"""
import ctypes
import errno
import fcntl
import json
import os
import select
import socket
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
# No symlinks or FIFOs: a tree some unsandboxed process reads must hold only inert regular
# files. A symlink's target isn't an access Landlock mediates, so one here would let the
# server read for us whatever we can't read ourselves.
RW = RO | WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_DIR | MAKE_REG | REFER | TRUNCATE
# Only for a process's private scratch, which nothing outside the sandbox reads.
RW_LINKS = RW | MAKE_SYM
BIND_TCP, CONNECT_TCP = 1, 2
MIN_ABI = 4  # TCP port rules

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
SYS_SECCOMP, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER = 317, 1, 8
PR_SET_NO_NEW_PRIVS, PR_SET_CHILD_SUBREAPER = 38, 36
ROOT_PID = os.getpid()  # survives the exec below, so it names the sandbox's tree

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
    to the user bus would be a full escape), and io_uring would sidestep a socket() filter.
    Its TCP rules also miss MPTCP sockets and MSG_FASTOPEN sends (both reached a listener on
    an unlisted port here), so those are closed too. Returns the listener fd for TARGETED."""
    AUDIT_ARCH_X86_64 = 0xC000003E
    LD_W_ABS, JEQ_K, JGE_K, RET_K, ALU_AND_K = 0x20, 0x15, 0x35, 0x06, 0x54
    ARG = lambda n: 16 + 8 * n  # low word of seccomp_data.args[n]
    ALLOW, NOTIFY, KILL = 0x7FFF0000, 0x7FC00000, 0x80000000
    DENY_EPERM, DENY_EAFNO, DENY_EOPNOTSUPP, ENOSYS = 0x00050001, 0x00050061, 0x0005005F, 0x00050026
    MSG_FASTOPEN = 0x20000000
    deny = {425: ENOSYS, 426: ENOSYS, 427: ENOSYS,  # io_uring_*
            321: DENY_EPERM, 298: DENY_EPERM, 310: DENY_EPERM, 311: DENY_EPERM,  # bpf perf process_vm_*
            101: DENY_EPERM, 248: DENY_EPERM, 249: DENY_EPERM, 250: DENY_EPERM}  # ptrace, keys

    def when(nr, body):  # run body (which must end by returning) for syscall nr
        return [(JEQ_K, 0, len(body), nr), *body]

    def no_fastopen(nr, arg):
        return when(nr, [(LD_W_ABS, 0, 0, ARG(arg)), (ALU_AND_K, 0, 0, MSG_FASTOPEN),
                         (JEQ_K, 0, 1, MSG_FASTOPEN), (RET_K, 0, 0, DENY_EOPNOTSUPP), (RET_K, 0, 0, ALLOW)])

    def equal_or_notify(nr, arg, value):  # the cheap, always-safe case skips the supervisor
        return when(nr, [(LD_W_ABS, 0, 0, ARG(arg)), (JEQ_K, 0, 1, value), (RET_K, 0, 0, ALLOW), (RET_K, 0, 0, NOTIFY)])

    prog = [(LD_W_ABS, 0, 0, 4), (JEQ_K, 1, 0, AUDIT_ARCH_X86_64), (RET_K, 0, 0, KILL),
            (LD_W_ABS, 0, 0, 0), (JGE_K, 0, 1, 0x40000000), (RET_K, 0, 0, DENY_EPERM)]
    for nr, action in deny.items():
        prog += [(JEQ_K, 0, 1, nr), (RET_K, 0, 0, action)]

    # Anything aimed at another process goes past the supervisor, which only lets it through
    # for this sandbox's own tree. Runtimes signal their own threads constantly (and this
    # pid survives exec), so that one case stays in the kernel.
    prog += equal_or_notify(TGKILL, 0, os.getpid())
    for nr, (arg, _) in TARGETED.items():
        if nr != TGKILL:
            prog += equal_or_notify(nr, arg, 0) if nr in ZERO_MEANS_SELF else when(nr, [(RET_K, 0, 0, NOTIFY)])
    # F_SETOWN and friends make the kernel signal a chosen pid on I/O, with no kill() in sight.
    prog += when(72, [(LD_W_ABS, 0, 0, ARG(1)), (JEQ_K, 1, 0, 8), (JEQ_K, 0, 1, 15),
                      (RET_K, 0, 0, DENY_EPERM), (RET_K, 0, 0, ALLOW)])  # fcntl F_SETOWN(_EX)
    prog += when(16, [(LD_W_ABS, 0, 0, ARG(1)), (JEQ_K, 1, 0, 0x8901), (JEQ_K, 0, 1, 0x8902),
                      (RET_K, 0, 0, DENY_EPERM), (RET_K, 0, 0, ALLOW)])  # ioctl FIOSETOWN, SIOCSPGRP

    prog += no_fastopen(44, 3) + no_fastopen(46, 2) + no_fastopen(307, 3)  # sendto sendmsg sendmmsg
    # socketpair(): stream only. An unbound datagram socket can address named UNIX listeners.
    prog += when(53, [(LD_W_ABS, 0, 0, ARG(1)), (ALU_AND_K, 0, 0, 0xF), (JEQ_K, 1, 0, 1),
                      (RET_K, 0, 0, DENY_EAFNO), (RET_K, 0, 0, ALLOW)])
    prog += [(JEQ_K, 1, 0, 41), (RET_K, 0, 0, ALLOW)]
    # socket(): only AF_INET/AF_INET6, only plain TCP/UDP, and only stream unless UDP was asked for.
    prog += [(LD_W_ABS, 0, 0, ARG(0)), (JEQ_K, 2, 0, 2), (JEQ_K, 1, 0, 10), (RET_K, 0, 0, DENY_EAFNO),
             (LD_W_ABS, 0, 0, ARG(2)), (JEQ_K, 3, 0, 0), (JEQ_K, 2, 0, 6), (JEQ_K, 1, 0, 17), (RET_K, 0, 0, DENY_EAFNO),
             (LD_W_ABS, 0, 0, ARG(1)), (ALU_AND_K, 0, 0, 0xF)]
    prog += [(JEQ_K, 2, 0, 1), (JEQ_K, 1, 0, 2)] if allow_udp else [(JEQ_K, 1, 0, 1)]
    prog += [(RET_K, 0, 0, DENY_EAFNO), (RET_K, 0, 0, ALLOW)]
    filt = b"".join(struct.pack("<HBBI", *ins) for ins in prog)
    buf = ctypes.create_string_buffer(filt)
    fprog = ctypes.create_string_buffer(struct.pack("<H6xQ", len(prog), ctypes.addressof(buf)))
    listener = libc.syscall(SYS_SECCOMP, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, fprog)
    if listener < 0:
        die(f"seccomp failed: errno {ctypes.get_errno()}")
    return listener


# ---- same-uid reach ---------------------------------------------------------------------
# Landlock can't scope signals below ABI 6 (this kernel: 4), unprivileged user namespaces are
# blocked by AppArmor so there's no PID namespace, and a second uid needs root setup. The
# job's own runtimes must still signal their children, so a blanket seccomp deny won't do.
# A seccomp listener decides instead, per call, from registers the caller can't change after
# the fact: allowed only if every target descends from this sandbox's root process.

TGKILL = 234
# nr: (index of the pid argument, how to read the target)
TARGETED = {
    62: (0, "kill"), 200: (0, "pid"), TGKILL: (1, "pid"), 129: (0, "pid"), 297: (1, "pid"),  # kill tkill tgkill rt_sigqueueinfo rt_tgsigqueueinfo
    434: (0, "pid"),  # pidfd_open: a pidfd can't be had for anything outside, so pidfd_send_signal needs no gate
    302: (0, "pid"), 203: (0, "pid"), 144: (0, "pid"), 142: (0, "pid"), 314: (0, "pid"),  # prlimit64 sched_setaffinity sched_setscheduler sched_setparam sched_setattr
    141: (1, "prio"), 251: (1, "ioprio"),  # setpriority ioprio_set: owner checks only, not ptrace
}
ZERO_MEANS_SELF = {302, 203, 144, 142, 314, 141, 251}


def proc_fields(pid):
    """(tgid, ppid, pgrp) or None when the task is gone."""
    try:
        with open(f"/proc/{pid}/status") as f:
            status = f.read()
        with open(f"/proc/{pid}/stat") as f:
            stat_line = f.read()
    except OSError:
        return None
    fields = dict(line.split(":\t", 1) for line in status.splitlines() if ":\t" in line)
    return int(fields["Tgid"]), int(fields["PPid"]), int(stat_line.rsplit(")", 1)[1].split()[2])


def in_tree(pid, root):
    for _ in range(4096):
        info = proc_fields(pid)
        if info is None:
            return False
        tgid, ppid, _pgrp = info
        if tgid == root:
            return True
        if ppid <= 1:
            return False
        pid = ppid
    return False


def group_verdict(pgrp, root):
    members = [int(d) for d in os.listdir("/proc") if d.isdigit()
               and (proc_fields(d) or (0, 0, -1))[2] == pgrp]
    if not members:
        return errno.ESRCH
    return 0 if all(in_tree(m, root) for m in members) else errno.EPERM


def pid_verdict(pid, root):
    if pid <= 0 or pid > 0x7FFFFFFF:
        return errno.EPERM
    if proc_fields(pid) is None:
        return errno.ESRCH
    return 0 if in_tree(pid, root) else errno.EPERM


def verdict(caller, nr, args, root):
    """0 lets the call run, otherwise the errno to fail it with."""
    arg, kind = TARGETED.get(nr, (0, None))
    target = ctypes.c_int32(args[arg] & 0xFFFFFFFF).value
    if kind == "pid":
        return pid_verdict(target, root)
    if kind == "kill":
        if target > 0:
            return pid_verdict(target, root)
        if target == -1:
            return errno.EPERM  # every process this uid can reach
        info = proc_fields(caller) if target == 0 else None
        if target == 0 and info is None:
            return errno.ESRCH
        return group_verdict(info[2] if target == 0 else -target, root)
    which = args[0] & 0xFFFFFFFF
    if kind == "prio":
        scope = {0: "process", 1: "group"}.get(which)
    elif kind == "ioprio":
        scope = {1: "process", 2: "group"}.get(which)
    else:
        scope = None
    if target == 0 or (scope == "process" and target == caller):
        return 0 if scope else errno.EPERM
    if scope == "process":
        return pid_verdict(target, root)
    if scope == "group":
        return group_verdict(target, root)
    return errno.EPERM  # PRIO_USER: every process this uid owns


def supervise(listener, root):
    NOTIF_RECV, NOTIF_SEND, FLAG_CONTINUE = 0xC0502100, 0xC0182101, 1
    waiter = select.poll()
    waiter.register(listener, select.POLLIN)
    req = ctypes.create_string_buffer(80)
    while True:
        events = waiter.poll()
        if any(ev & (select.POLLHUP | select.POLLERR) for _, ev in events):
            return  # the whole tree has gone
        ctypes.memset(req, 0, 80)
        try:
            fcntl.ioctl(listener, NOTIF_RECV, req, True)
        except OSError:
            continue  # the caller died or was interrupted
        notif_id, caller, _flags, nr, _arch, _ip, *args = struct.unpack("<QIIiIQ6Q", req.raw)
        try:
            err = verdict(caller, nr, args, root)
        except Exception:
            err = errno.EPERM
        resp = ctypes.create_string_buffer(
            struct.pack("<QqiI", notif_id, 0, -err if err else 0, 0 if err else FLAG_CONTINUE))
        try:
            fcntl.ioctl(listener, NOTIF_SEND, resp, True)
        except OSError:
            pass  # the caller died while we decided


def start_supervisor(channel):
    """Double-forks, so the supervisor is outside the tree and the tree can't signal it. If it
    dies anyway, gated syscalls fail with ENOSYS: the kernel fails closed. Holds nothing of the
    job's: no stdio, no environment, reads /proc and nothing else."""
    if os.fork():
        os.wait()
        return
    if os.fork():
        os._exit(0)
    try:
        os.environ.clear()
        devnull = os.open("/dev/null", os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
        _, fds, _, _ = socket.recv_fds(channel, 1, 1)
        libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        landlock([("/proc", RO)], [])
        channel.send(b"k")
        channel.close()
        supervise(fds[0], ROOT_PID)
    except BaseException:
        pass
    os._exit(0)


def main(argv):
    rules, ports, allow_udp, env_file, i = [], [], False, None, 0
    while i < len(argv) and argv[i] != "--":
        flag = argv[i]
        if flag == "--allow-udp":
            allow_udp = True
            i += 1
        elif flag in ("--ro", "--rox", "--rw", "--rw-links"):
            rules.append((argv[i + 1], {"--ro": RO, "--rox": ROX, "--rw": RW, "--rw-links": RW_LINKS}[flag]))
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
    ours, theirs = socket.socketpair()
    start_supervisor(theirs)
    theirs.close()
    env = os.environ
    if env_file:
        with open(env_file) as f:
            env = json.load(f)
        os.unlink(env_file)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die("no_new_privs failed")
    # Orphans re-parent to the root, so a double fork can't leave the tree (or reach it back).
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        die("subreaper failed")
    landlock(rules, ports)
    listener = seccomp(allow_udp)
    socket.send_fds(ours, [b"f"], [listener])
    if ours.recv(1) != b"k":
        die("supervisor failed")  # fail closed: without it, signals would just all fail
    os.close(listener)
    ours.close()
    try:
        os.execvpe(cmd[0], cmd, env)
    except OSError as e:
        die(f"exec {cmd[0]}: {e}")


main(sys.argv[1:])

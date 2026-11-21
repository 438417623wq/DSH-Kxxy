#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guard --link-dest capability; never rewrite rsync arguments or its output tree.

Only native hard links count as support. A successful probe establishes capability
for new, caller-owned files in the actual local basis/destination directories, not
that every existing basis file can be linked (permissions/attributes may differ).
Remote, ambiguous, missing-directory and dry-run cases remain unverified.
Usage: kxxy-rsync.py <real-rsync> [original rsync arguments...]
"""

import os
import secrets
import stat
import sys
import tempfile


# Exact spellings only: rsync abbreviations and unfamiliar options are opaque.
# In particular, operands to -e/-f/--exclude/etc. are not source/destination paths
# or options, even if they look like --link-dest or --dry-run.
LONG_VALUES = frozenset("""
    --link-dest --copy-dest --compare-dest --exclude --exclude-from --include
    --include-from --filter --files-from --rsh --rsync-path --out-format
    --log-file --log-file-format --password-file --suffix --backup-dir --temp-dir
    --partial-dir --max-size --min-size --bwlimit --block-size --timeout
    --contimeout --compress-level --skip-compress --chmod --usermap --groupmap
    --chown --protocol --max-delete --checksum-choice --compress-choice --iconv
    --address --port --sockopts --remote-option --write-batch --only-write-batch
    --read-batch --max-alloc --stop-after --stop-at --info --debug --modify-window
    --checksum-seed
""".split())
LONG_FLAGS = frozenset("""
    --archive --recursive --relative --no-implied-dirs --backup --update --inplace
    --append --append-verify --dirs --old-dirs --mkpath --links --copy-links
    --copy-unsafe-links --safe-links --munge-links --copy-dirlinks --keep-dirlinks
    --hard-links --perms --executability --acls --xattrs --owner --group --devices
    --specials --copy-devices --write-devices --times --omit-dir-times
    --omit-link-times --atimes --open-noatime --crtimes --super --fake-super
    --sparse --preallocate --dry-run --whole-file --one-file-system
    --existing --ignore-existing --remove-source-files --del --delete
    --delete-before --delete-during --delete-delay --delete-after --delete-excluded
    --ignore-missing-args --delete-missing-args --ignore-errors --force
    --prune-empty-dirs --numeric-ids --checksum --ignore-times --size-only
    --compress --compress-args --skip-compress-args --partial --delay-updates
    --progress --stats --human-readable --itemize-changes --verbose --quiet
    --fuzzy --cvs-exclude --inc-recursive --ignore-non-existing
    --8-bit-output --from0 --protect-args --secluded-args --old-args --blocking-io
    --msgs2stderr --stderr --list-only --help --version --ipv4 --ipv6 --fsync
""".split()) - {"--stderr"}  # --stderr has a value in current rsync.
LONG_VALUES = LONG_VALUES | {"--stderr"}
SHORT_FLAGS = frozenset("0468abcCdDEFghHiklKLmNnopPqJOrRsStuvVWxXyzUAI")
SHORT_VALUES = frozenset("BefMT@")
OPAQUE_OPTIONS = frozenset({
    "--remote-option", "--read-batch", "--write-batch", "--only-write-batch",
    "--list-only", "--help", "--version", "--copy-devices", "--write-devices",
})


class Arguments:
    def __init__(self):
        self.link_dests = []
        self.paths = []
        self.dry_run = False
        self.problem = None
        self.possible_link_dest = False


def possible_link_option(argv):
    """Signal in the opaque tail only; never used to choose probe paths.

    An unknown option might consume a following '--' as its operand, so this
    tail cannot safely infer option termination. Strict rejects ambiguity; warn
    still execs unchanged. A successfully parsed '--' is never scanned here.
    """
    for arg in argv:
        name = arg.partition("=")[0]
        if name.startswith("--l") and "--link-dest".startswith(name):
            return True
    return False


def parse_arguments(argv):
    result = Arguments()
    i = 0
    options = True
    while i < len(argv):
        arg = argv[i]
        if options and arg == "--":
            options = False
        elif options and arg.startswith("--"):
            name, equal, value = arg.partition("=")
            if name in LONG_VALUES:
                if name == "--link-dest":
                    result.possible_link_dest = True
                if not equal:
                    i += 1
                    if i == len(argv):
                        result.problem = "missing operand for " + name
                        break
                    value = argv[i]
                if name == "--link-dest":
                    result.link_dests.append(value)
                if name in OPAQUE_OPTIONS:
                    result.problem = "unsupported option " + name
            elif name in LONG_FLAGS or (
                name.startswith("--no-") and "--" + name[5:] in LONG_FLAGS
            ) or name in ("--no-n", "--no-a", "--no-r", "--no-D"):
                if equal:
                    result.problem = "unexpected operand for " + name
                    break
                if name == "--dry-run":
                    result.dry_run = True
                elif name in ("--no-dry-run", "--no-n"):
                    result.dry_run = False
                if name in OPAQUE_OPTIONS:
                    result.problem = "unsupported option " + name
            else:
                result.problem = "unrecognized option " + name
                break
        elif options and arg.startswith("-") and arg != "-":
            j = 1
            while j < len(arg):
                flag = arg[j]
                if flag in SHORT_VALUES:
                    if j + 1 == len(arg):
                        i += 1
                        if i == len(argv):
                            result.problem = "missing operand for -" + flag
                    if flag == "M":
                        result.problem = "unsupported option -M"
                    break  # The rest of this token is the operand, not flags.
                if flag not in SHORT_FLAGS:
                    result.problem = "unrecognized option -" + flag
                    break
                if flag == "n":
                    result.dry_run = True
                if flag in "hV" and (flag == "V" or arg == "-h"):
                    # -h alone is help; bundled -h is human-readable output.
                    result.problem = "help/version invocation is not a transfer"
                j += 1
            if result.problem:
                break
        else:
            result.paths.append(arg)
        i += 1
    result.possible_link_dest = result.possible_link_dest or bool(result.link_dests) or (
        bool(result.problem) and possible_link_option(argv[i:])
    )
    return result


def is_remote(path):
    # Absolute paths and ./foo:bar are local; host:path and rsync:// are not.
    if path.startswith("rsync://"):
        return True
    if os.path.isabs(path):
        return False
    return ":" in path.split("/", 1)[0]


def local_candidates(parsed):
    """Return actual existing directories only, or a reason they are unverified."""
    if parsed.problem:
        return None, parsed.problem
    if parsed.dry_run:
        return None, "dry-run: no capability probe files are created"
    if len(parsed.paths) < 2:
        return None, "source/destination operands cannot be determined"
    if any(is_remote(path) for path in parsed.paths):
        return None, "remote transfers cannot be verified locally"
    destination = os.path.realpath(os.path.abspath(parsed.paths[-1]))
    if not os.path.isdir(destination):
        return None, "destination is not an existing local directory"
    candidates = []
    for basis in parsed.link_dests:
        if not basis or is_remote(basis):
            return None, "basis is empty or not a local directory"
        # rsync resolves relative --link-dest against the receiver's destination.
        basis = os.path.realpath(os.path.join(destination, basis))
        if not os.path.isdir(basis):
            return None, "basis is not an existing local directory: " + basis
        pair = (basis, destination)
        if pair not in candidates:
            candidates.append(pair)
    return candidates, None


def _native_link(source, link):
    """link(2) 直通。部分 Android 原生解释器没有 os.link（bionic 构建裁掉了），
    这时退到 ctypes 直调 libc 的 link()；语义与 os.link 一致（失败抛 OSError）。"""
    try:
        os.link(source, link)
        return
    except AttributeError:
        pass
    import ctypes
    lib = ctypes.CDLL("libc.so", use_errno=True)
    lib.link.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    lib.link.restype = ctypes.c_int
    ctypes.set_errno(0)
    if lib.link(os.fsencode(source), os.fsencode(link)) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def probe_hardlinks(basis, destination):
    """Native link(2), directly in the candidate directories, of owned temp files.

    No existing user file is opened, linked, removed, chmod'ed or traversed.
    The destination name is never removed if os.link failed (e.g. EEXIST).
    No parent-directory/mount/device heuristic can substitute for this probe.
    """
    source = None
    link = None
    link_created = False
    supported = False
    problem = None
    fd = None
    try:
        fd, source = tempfile.mkstemp(prefix=".kxxy-link-probe-", dir=basis)
        before = os.fstat(fd)
        os.close(fd)
        fd = None
        link = os.path.join(destination, ".kxxy-link-probe-" + secrets.token_hex(16))
        _native_link(source, link)
        link_created = True
        source_stat = os.lstat(source)
        link_stat = os.lstat(link)
        supported = (
            stat.S_ISREG(before.st_mode)
            and before.st_nlink == 1
            and stat.S_ISREG(source_stat.st_mode)
            and stat.S_ISREG(link_stat.st_mode)
            and before.st_ino != 0
            and before.st_dev == source_stat.st_dev == link_stat.st_dev
            and before.st_ino == source_stat.st_ino == link_stat.st_ino
            and source_stat.st_nlink >= 2
            and link_stat.st_nlink >= 2
        )
        if not supported:
            problem = "native link did not produce matching regular-file device/inode/nlink"
    except (OSError, NotImplementedError) as ex:
        problem = "native hard-link probe failed: " + str(ex)
    finally:
        if fd is not None:
            os.close(fd)
        for path in (link if link_created else None, source):
            if path is not None:
                try:
                    os.unlink(path)
                except OSError as ex:
                    supported = False
                    problem = "capability probe cleanup failed: " + str(ex)
    return supported, problem


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if not args:
        sys.stderr.write("kxxy-rsync: internal usage <real-rsync> [args...]\n")
        return 2
    real, argv = args[0], args[1:]
    strict = os.environ.get("KXXY_RSYNC_LINK_STRICT", "0") == "1"
    # Removed mode must fail even without --link-dest, before any filesystem work
    # or rsync execution. QUIET/mode/fallback must never override strict policy.
    if os.environ.get("KXXY_RSYNC_LINK_MODE", "warn") == "symlink":
        sys.stderr.write(
            "kxxy-rsync: KXXY_RSYNC_LINK_MODE=symlink is disabled: symbolic links "
            "do not preserve rsync --link-dest semantics; no transfer was run.\n"
        )
        return 1

    parsed = parse_arguments(argv)
    if parsed.possible_link_dest:
        candidates, problem = local_candidates(parsed)
        if candidates is not None:
            for basis, destination in candidates:
                supported, problem = probe_hardlinks(basis, destination)
                if not supported:
                    break
            else:
                problem = None
        if problem:
            if strict:
                sys.stderr.write(
                    "kxxy-rsync: strict --link-dest rejected: " + problem +
                    "; hard-link capability is unverified/unsupported. "
                    "No rsync transfer was run.\n"
                )
                return 1
            if os.environ.get("KXXY_RSYNC_QUIET", "0") != "1":
                sys.stderr.write(
                    "kxxy-rsync: warning: " + problem +
                    "; --link-dest hard-link capability is unverified/unsupported. "
                    "Running native rsync unchanged; it may copy instead of linking.\n"
                )
    # exec inherits stdout/stderr, native status and signal handling. There is no
    # output capture, compare-dest substitution, linkify phase or postprocessing.
    try:
        os.execv(real, [real] + argv)
    except OSError as ex:
        sys.stderr.write("kxxy-rsync: cannot execute " + real + ": " + str(ex) + "\n")
        return 127 if isinstance(ex, FileNotFoundError) else 126
    return 0  # Only reachable with a mocked exec in regression tests.


if __name__ == "__main__":
    sys.exit(main())

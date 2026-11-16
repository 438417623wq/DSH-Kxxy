"""Verify the packaged Codex sidebar without loading the APK/runtime into memory."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def digest_stream(stream):
    digest = hashlib.sha256()
    while block := stream.read(4 * 1024 * 1024):
        digest.update(block)
    return digest.hexdigest()


CODEX_PIN = {
    "version": "0.167.0",
    "target": "aarch64-unknown-linux-musl",
    "archiveSha256": "843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281",
    "binarySha256": "2fe94d848540ff2a6868c7ebcc494126a974aa409711676d14fa0379e49e6143",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--native-app", action="store_true",
                        help="Require the pinned official Codex CLI bundled in verified app-process execution mode")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    project = args.project.resolve()
    with zipfile.ZipFile(args.apk) as apk, zipfile.ZipFile(args.runtime) as runtime:
        assert len(apk.namelist()) == len(set(apk.namelist())), "Duplicate APK entries"
        assert len(runtime.namelist()) == len(set(runtime.namelist())), "Duplicate runtime entries"
        meta = json.loads(apk.read("assets/meta/build.json"))
        manifest = json.loads(runtime.read("kxxy-runtime.json"))
        packed_runtime = apk.getinfo("assets/runtime.zip")
        assert packed_runtime.compress_type == zipfile.ZIP_STORED, "runtime.zip must use STORE"
        assert packed_runtime.file_size == args.runtime.stat().st_size == meta["runtimeSize"], "Runtime size mismatch"
        with apk.open(packed_runtime) as stream:
            runtime_digest = digest_stream(stream)
        with args.runtime.open("rb") as stream:
            assert digest_stream(stream) == runtime_digest == meta["runtimeSha256"], "Runtime digest mismatch"
        source_root = project / "plugins" / "dsh-codex-sidebar"
        base = "lib/node_modules/dsh-codex-sidebar/"
        checked = []
        fingerprint_rows = []
        for source in sorted(source_root.rglob("*")):
            if not source.is_file():
                continue
            relative = source.relative_to(source_root).as_posix()
            if relative == "plugin.fingerprint":
                continue
            actual = runtime.read(base + relative)
            assert actual == source.read_bytes(), f"Stale plugin source: {relative}"
            checked.append(relative)
            fingerprint_rows.append(f"{relative}\t{hashlib.sha256(actual).hexdigest()}")
        fingerprint = hashlib.sha256("\n".join(sorted(fingerprint_rows)).encode()).hexdigest()
        assert runtime.read(base + "plugin.fingerprint").decode().strip() == fingerprint, "Plugin fingerprint mismatch"
        assert meta["codexPluginFingerprint"] == manifest["plugins"]["codexFingerprint"] == fingerprint, "APK expected plugin fingerprint mismatch"
        package = json.loads(runtime.read(base + "package.json"))
        assert package["name"] == "dsh-codex-sidebar"
        assert package["dsh"]["client"]["platform"] == "web"
        assert package["exports"]["./client"] == "./lib/client.js"
        assert b"__ModuleLoader__.load" in runtime.read(base + "lib/client.js")
        installation = json.loads(runtime.read("lib/node_modules/@deepseek-ai/dsh/package.json"))
        assert installation["dependencies"]["dsh-codex-sidebar"] == package["version"], "Missing installation-scope registration"
        host_package = json.loads(runtime.read("lib/node_modules/kxxy-host/package.json"))
        assert host_package["exports"]["./auth"] == "./lib/auth.mjs", "Shared auth export missing"
        for relative in ("lib/auth.mjs", "package.json"):
            assert runtime.read("lib/node_modules/kxxy-host/" + relative) == (project / "plugins" / "kxxy-host" / relative).read_bytes(), "Stale host auth source"
        native_included = bool(meta["codexRuntimeIncluded"])
        assert native_included == manifest["plugins"]["codexRuntime"]["included"]
        if args.native_app:
            assert native_included, "--native-app requires the bundled Codex runtime"
            runtime_meta = manifest["plugins"]["codexRuntime"]
            assert runtime_meta.get("executionMode") == "app-process", "Codex runtime must be app-process mode"
            assert runtime_meta.get("appServerVerified") is True, "Codex runtime app-server verification missing"
            assert runtime_meta.get("sandboxVerified") is False, "app-process mode must not claim sandbox isolation"
            assert meta.get("codexRuntimeExecutionMode") == "app-process", "APK metadata execution mode mismatch"
            assert meta.get("codexRuntimeAppServerVerified") is True, "APK metadata app-server verification missing"
            assert "bin/codex" in runtime.namelist(), "Bundled Codex executable missing"
            assert "lib/codex/runtime.json" in runtime.namelist(), "Codex runtime manifest missing"
            assert "bin/bwrap" not in runtime.namelist(), "app-process mode must not bundle bwrap"
            codex_manifest = json.loads(runtime.read("lib/codex/runtime.json"))
            for field, expected in (("version", CODEX_PIN["version"]), ("target", CODEX_PIN["target"]),
                                    ("archiveSha256", CODEX_PIN["archiveSha256"]),
                                    ("executionMode", "app-process"), ("appServerVerified", True), ("sandboxVerified", False)):
                assert codex_manifest.get(field) == expected, f"Codex runtime manifest {field} mismatch: {codex_manifest.get(field)!r}"
            assert codex_manifest.get("files", {}).get("codex") == CODEX_PIN["binarySha256"], "Codex runtime manifest binary digest mismatch"
            codex_data = runtime.read("bin/codex")
            assert codex_data[:4] == b"\x7fELF" and int.from_bytes(codex_data[18:20], "little") == 183, "Codex executable is not an ARM64 ELF"
            assert hashlib.sha256(codex_data).hexdigest() == CODEX_PIN["binarySha256"], "Codex executable digest mismatch"
            codex_mode = (runtime.getinfo("bin/codex").external_attr >> 16) & 0o7777
            assert codex_mode & 0o111 == 0o111, "Codex executable is not marked executable"
        else:
            assert not native_included, "This delivery must not silently bundle an unverified executable"
            assert "bin/codex" not in runtime.namelist(), "Unexpected Codex executable"
        assert manifest["plugins"]["hostFingerprint"] == meta["kxxyHostFingerprint"]
        assert b"fingerprint:" + meta["kxxyHostFingerprint"].encode() in runtime.read("lib/node_modules/kxxy-host/lib/.fingerprint")
        assert "lib/arm64-v8a/libdsh_pty.so" in apk.namelist(), "Missing native PTY library"
        dex_names = [name for name in apk.namelist() if name.startswith("classes") and name.endswith(".dex")]
        symbols = (b"codexSidebarSeeded", b"KXXY_CODEX_HOME", b"codexPluginIsCurrent")
        dexes = [apk.read(name) for name in dex_names]
        for symbol in symbols:
            assert any(symbol in data for data in dexes), f"Missing native plugin integration: {symbol.decode()}"
        pools = [entry for entry in apk.infolist() if entry.filename.startswith("assets/ext-pool/") and entry.filename.endswith(".pool")]
        assert pools and all(entry.file_size > 0 and entry.compress_type == zipfile.ZIP_STORED for entry in pools), "Missing/invalid extension pool assets"
    with args.apk.open("rb") as stream:
        apk_digest = digest_stream(stream)
    if native_included:
        limitations = [
            "Native Codex CLI executes with app permissions, not a kernel-level workspace sandbox; untrusted is the default, full access requires volatile per-thread confirmation",
            "Native readonly, tool-free native retry and native automatic file undo remain unavailable; controlled HTTP writes alone have reversible snapshots",
            "Protocol adapters and bridge require compatible provider tools; HTTP checks do not certify every native Codex feature",
            "Compatibility bridge replay is process-local; unsupported tools, multimodal input and remote compaction are rejected",
            "Asset verification does not certify real external-provider or same-version real CLI inference",
            "Asset verification does not perform browser pixel acceptance, device installation or on-device UI testing",
        ]
    else:
        limitations = ["Codex CLI is not included; native Codex sandbox execution remains blocked", "Custom agents require providers with compatible function calling; commands use app process permissions with per-operation approval", "No installation or on-device UI acceptance performed"]
    report = {
        "apk": str(args.apk.resolve()),
        "apkBytes": args.apk.stat().st_size,
        "sha256": apk_digest,
        "runtimeSha256": runtime_digest,
        "codexPluginVersion": package["version"],
        "codexPluginFingerprint": fingerprint,
        "pluginFilesCompared": checked,
        "nativeCodexIncluded": native_included,
        "codexRuntimeExecutionMode": meta.get("codexRuntimeExecutionMode"),
        "codexRuntimeAppServerVerified": meta.get("codexRuntimeAppServerVerified") is True,
        "extensionPools": len(pools),
        "checksPassed": True,
        "limitations": limitations,
    }
    if args.report:
        assert not args.report.exists(), "Refusing to replace an existing verification report"
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

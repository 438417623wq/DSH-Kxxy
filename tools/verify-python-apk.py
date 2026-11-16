#!/usr/bin/env python3
"""Verify Python repair assets and Android helper are present in the final APK.

Run with host Python -I. Reads ZIPs and hashes streams; never imports target packages.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(ok, message):
    if not ok:
        raise ValueError(message)


def verify(apk_path, runtime_path, project):
    assets = project / "android/app/src/main/assets"
    with zipfile.ZipFile(apk_path) as apk:
        names = apk.namelist()
        require(len(names) == len(set(names)), "Duplicate APK entries")
        meta_raw = apk.read("assets/meta/build.json")
        require(meta_raw == (assets / "meta/build.json").read_bytes(), "APK build metadata differs from validated source")
        meta = json.loads(meta_raw)
        manifest_raw = apk.read("assets/python-repair/manifest.json")
        payload_raw = apk.read("assets/python-repair/payload.zip")
        require(manifest_raw == (assets / "python-repair/manifest.json").read_bytes(), "APK repair manifest changed")
        require(payload_raw == (assets / "python-repair/payload.zip").read_bytes(), "APK repair payload changed")
        require(digest(manifest_raw) == meta["pythonRepairManifestSha256"], "APK manifest digest mismatch")
        manifest = json.loads(manifest_raw)
        require(digest(payload_raw) == manifest["payloadSha256"] and len(payload_raw) == manifest["payloadSize"], "APK payload digest/size mismatch")
        require(manifest["revision"] == meta["pythonRuntimeRevision"], "APK Python revision mismatch")
        require(manifest["hostFingerprint"] == meta["kxxyHostFingerprint"], "APK host fingerprint mismatch")
        runtime_hash = hashlib.sha256()
        runtime_size = 0
        with apk.open("assets/runtime.zip") as source:
            for data in iter(lambda: source.read(4 * 1024 * 1024), b""):
                runtime_hash.update(data)
                runtime_size += len(data)
        require(runtime_hash.hexdigest() == meta["runtimeSha256"] and runtime_size == meta["runtimeSize"], "Packaged runtime bytes differ from metadata")
        dexes = [name for name in names if name.startswith("classes") and name.endswith(".dex")]
        descriptors = (b"Lapp/kxxy/engine/PythonRuntimeRepair;", b"Lapp/kxxy/engine/RuntimeInstaller;")
        found = set()
        for name in dexes:
            data = apk.read(name)
            found.update(descriptor for descriptor in descriptors if descriptor in data)
        require(len(found) == len(descriptors), "APK dex misses the compiled Python repair helper or installer")
        with zipfile.ZipFile(io.BytesIO(payload_raw)) as payload, zipfile.ZipFile(runtime_path) as runtime:
            require(len(payload.infolist()) == len(manifest["files"]), "Payload count mismatch")
            for record in manifest["files"]:
                name = record["path"]
                data = payload.read(name)
                require(data == runtime.read(name), f"Payload/runtime mismatch: {name}")
                require(len(data) == record["size"] and digest(data) == record["sha256"], f"Invalid payload record: {name}")
            for name in ("lib/selftest.mjs", "lib/python-selftest.mjs", "lib/python-probe.py", "web/host.js", "web/index.html"):
                require(runtime.read("lib/node_modules/kxxy-host/" + name) == (project / "plugins/kxxy-host" / name).read_bytes(), f"Python selftest source mismatch: {name}")
    return {
        "schema": 1, "apk": str(apk_path), "pythonRevision": manifest["revision"],
        "runtimeSha256": runtime_hash.hexdigest(), "repairManifestSha256": digest(manifest_raw),
        "repairPayloadSha256": digest(payload_raw), "repairPayloadBytes": len(payload_raw),
        "repairFiles": len(manifest["files"]), "androidHelperIncluded": True,
        "pythonSelftestSourceMatches": True, "checksPassed": True,
        "deviceInstalled": False, "deviceVerified": False,
        "remainingWarnings": ["NumPy/psutil legacy Android wheel tags retained; use in-app functional selftest"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = verify(args.apk.resolve(), args.runtime.resolve(), args.project.resolve())
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        with args.report.open("x", encoding="utf-8") as output:
            output.write(text)
    print(text)


if __name__ == "__main__":
    main()

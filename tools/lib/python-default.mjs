/** Bare Python routing only: native bin/python* and absolute selftest paths stay intact. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PYTHON_DEFAULT_SOURCE = fileURLToPath(new URL('../prebuilt/kxxy-tools/python-default.py', import.meta.url))
export const PYTHON_DEFAULT_GLIBC_SOURCE = fileURLToPath(new URL('../prebuilt/wrappers/kxxy-glibc.sh', import.meta.url))
export const PYTHON_DEFAULT_GLIBC = 'libexec/python-default/kxxy-glibc'
export const PYTHON_DEFAULT_DISPATCHER = 'libexec/python-default/python-default.py'
export const PYTHON_DEFAULT_BIN = 'libexec/python-default/bin'
export const PYTHON_DEFAULT_PATHS = Object.freeze([
  PYTHON_DEFAULT_DISPATCHER, PYTHON_DEFAULT_GLIBC,
  ...['python', 'python3', 'pip', 'pip3'].map((name) => `${PYTHON_DEFAULT_BIN}/${name}`),
])

export function pythonDefaultWrappers() {
  const files = [
    { path: PYTHON_DEFAULT_DISPATCHER, data: readFileSync(PYTHON_DEFAULT_SOURCE), mode: 0o644 },
    { path: PYTHON_DEFAULT_GLIBC, data: readFileSync(PYTHON_DEFAULT_GLIBC_SOURCE), mode: 0o755 },
  ]
  for (const name of ['python', 'python3', 'pip', 'pip3']) {
    // Absolute native interpreter and -I are essential: never recursively resolve
    // Python through PATH or import user cwd/PYTHONPATH in this bionic dispatcher.
    const body = `#!/system/bin/sh\n# kxxy default Python: no implicit provisioning.\nROOT=@DSH_ROOT@\nexec "$ROOT/bin/python" -I "$ROOT/${PYTHON_DEFAULT_DISPATCHER}" --command ${name} -- "$@"\n`
    files.push({ path: `${PYTHON_DEFAULT_BIN}/${name}`, data: Buffer.from(body), mode: 0o755 })
  }
  return files
}
export const buildPythonDefaultFiles = pythonDefaultWrappers
// Use exactly the same placeholder discovery as runtime assembly, not a manual
// list which drifts when a template acquires a new installed-path token.
export const placeholderPaths = Object.freeze(pythonDefaultWrappers()
  .filter(({ data }) => /@DSH_(ROOT|HOME|TMP|FILES|DATA)@/.test(data.toString('utf8')))
  .map(({ path }) => path))

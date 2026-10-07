/**
 * Sandboxie engine access.
 *
 * Two entry points exist and both are used here, for different reasons:
 *
 * - `SbieDll.dll!SbieDll_RunSandboxed` (stdcall, 6 args / 24 bytes — pin the
 *   arity against `SboxDll32.def`, `SbieDll_RunSandboxed=_SbieDll_RunSandboxed@24`)
 *   starts a process *inside* a box with no GUI involvement. It is the only
 *   documented-ish way to do that without `Start.exe`, which is a GUI-subsystem
 *   binary and therefore cannot carry pipes (measured, see M0 notes).
 *   The process is materialised by `SbieSvc` (Sandboxie's own comment in
 *   `start.cpp` says so), which is why our `STARTUPINFOW` std handles are
 *   *ignored*: the boxed side has to talk back over TCP.
 * - `SbieIni.exe` mutates box configuration. It writes `Sandboxie.ini` through
 *   the service, so it works from an ordinary, non-elevated, non-admin process.
 *   Writing that file directly would need an administrator token.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadKoffi } from "./koffi.mjs";

export const SBIE_DIR_CANDIDATES = [
  process.env.DSH_SBIE_DIR,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Sandboxie-Plus"),
  process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Sandboxie-Plus"),
  process.env.ProgramW6432 && path.join(process.env.ProgramW6432, "Sandboxie-Plus"),
  "C:\\Program Files\\Sandboxie-Plus"
].filter((value) => typeof value === "string" && value.length > 0);

/** The Sandboxie installation directory, or undefined when not installed. */
export function sbieDir() {
  for (const dir of SBIE_DIR_CANDIDATES) {
    if (fs.existsSync(path.join(dir, "SbieDll.dll"))) return dir;
  }
  return undefined;
}

export function sbieExe(name) {
  const dir = sbieDir();
  if (dir === undefined) throw new Error("Sandboxie-Plus is not installed (SbieDll.dll not found)");
  return path.join(dir, name);
}

/** Sandboxie's own default per-user sandbox root (re-exported from the pure naming module). */
export { sbieSandboxRoot } from "./naming.mjs";

// ---------------------------------------------------------------------------
// SbieDll.dll
// ---------------------------------------------------------------------------

const STARTF_USESHOWWINDOW = 0x00000001;
const SW_HIDE = 0;

let api;

/**
 * Load `SbieDll.dll` and declare only the exports this plugin needs.
 * Loading the DLL into a plain Node process is safe: outside a box its hooks
 * are pass-through (`Dll_BoxName` is unset), which is exactly what `Start.exe`
 * does for itself.
 */
export function sbieApi() {
  if (api !== undefined) return api;
  const dir = sbieDir();
  if (dir === undefined) throw new Error("Sandboxie-Plus is not installed (SbieDll.dll not found)");
  const koffi = loadKoffi();
  const kernel32 = koffi.load("kernel32.dll");
  const dll = koffi.load(path.join(dir, "SbieDll.dll"));

  const STARTUPINFOW = koffi.struct("STARTUPINFOW", {
    cb: "uint32",
    lpReserved: "void *",
    lpDesktop: "void *",
    lpTitle: "void *",
    dwX: "uint32",
    dwY: "uint32",
    dwXSize: "uint32",
    dwYSize: "uint32",
    dwXCountChars: "uint32",
    dwYCountChars: "uint32",
    dwFillAttribute: "uint32",
    dwFlags: "uint32",
    wShowWindow: "uint16",
    cbReserved2: "uint16",
    lpReserved2: "void *",
    hStdInput: "void *",
    hStdOutput: "void *",
    hStdError: "void *"
  });
  const PROCESS_INFORMATION = koffi.struct("PROCESS_INFORMATION", {
    hProcess: "void *",
    hThread: "void *",
    dwProcessId: "uint32",
    dwThreadId: "uint32"
  });

  api = {
    koffi,
    STARTUPINFOW,
    PROCESS_INFORMATION,
    runSandboxed: dll.func("__stdcall", "SbieDll_RunSandboxed", "bool", [
      "void *", // const WCHAR *boxName
      "void *", // WCHAR *commandLine   (mutable: CreateProcess semantics)
      "void *", // WCHAR *currentDirectory
      "uint32", // ULONG flags — CreateProcess creation flags, 0 is what Start.exe passes
      koffi.inout(koffi.pointer(STARTUPINFOW)),
      koffi.out(koffi.pointer(PROCESS_INFORMATION))
    ]),
    getStartError: dll.func("__stdcall", "SbieDll_GetStartError", "void *", []),
    enumBoxes: dll.func("__stdcall", "SbieApi_EnumBoxes", "int32", ["uint32", "void *"]),
    reloadConf: dll.func("__stdcall", "SbieApi_ReloadConf", "int32", ["int32", "uint32"]),
    queryBoxPath: dll.func("__stdcall", "SbieApi_QueryBoxPath", "int32", [
      "void *", "void *", "void *", "void *", "void *", "void *", "void *"
    ]),
    waitForSingleObject: kernel32.func("WaitForSingleObject", "uint32", ["void *", "uint32"]),
    getExitCodeProcess: kernel32.func("GetExitCodeProcess", "bool", ["void *", koffi.out(koffi.pointer("uint32"))]),
    closeHandle: kernel32.func("CloseHandle", "bool", ["void *"]),
    terminateProcess: kernel32.func("TerminateProcess", "bool", ["void *", "uint32"]),
    getLastError: kernel32.func("GetLastError", "uint32", []),
    freeMem: dll.func("__stdcall", "SbieDll_FreeMem", "bool", ["void *"])
  };
  return api;
}

const wstr = (value) => Buffer.from(`${value}\0`, "utf16le");

/** Human-readable text for the failure of the most recent `SbieDll_RunSandboxed`. */
export function startErrorText() {
  try {
    const { getStartError, koffi } = sbieApi();
    const ptr = getStartError();
    if (ptr === null || ptr === 0 || ptr === 0n) return undefined;
    const text = koffi.decode(ptr, "str16");
    return typeof text === "string" && text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start `commandLine` inside `box` through the Sandboxie service.
 *
 * @param {{box: string, commandLine: string, cwd: string, flags?: number, inheritStdHandles?: boolean}} request
 * @returns {{ok: true, pid: number, hProcess: unknown, hThread: unknown} | {ok: false, error: string}}
 */
export function runSandboxed(request) {
  const a = sbieApi();
  const si = {
    cb: 104,
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: STARTF_USESHOWWINDOW,
    wShowWindow: SW_HIDE,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: null,
    hStdOutput: null,
    hStdError: null
  };
  const pi = {};
  const ok = a.runSandboxed(wstr(request.box), wstr(request.commandLine), wstr(request.cwd), request.flags ?? 0, si, pi);
  if (!ok) return { ok: false, error: startErrorText() ?? `SbieDll_RunSandboxed failed (Win32 error ${a.getLastError()})` };
  return { ok: true, pid: pi.dwProcessId, hProcess: pi.hProcess, hThread: pi.hThread };
}

/** Wait for a process handle; returns the exit code, or undefined on timeout. */
export function waitForProcess(hProcess, timeoutMs) {
  const a = sbieApi();
  const rc = a.waitForSingleObject(hProcess, timeoutMs);
  if (rc !== 0) return undefined;
  const code = [0];
  a.getExitCodeProcess(hProcess, code);
  return code[0];
}

export function closeHandle(handle) {
  if (handle === null || handle === undefined) return;
  try {
    sbieApi().closeHandle(handle);
  } catch {}
}

/** Best-effort kill of a process we started through the engine (relay cleanup on failure). */
export function killProcess(hProcess, exitCode = 1) {
  if (hProcess === null || hProcess === undefined) return;
  try {
    const a = sbieApi();
    a.terminateProcess(hProcess, exitCode);
    a.closeHandle(hProcess);
  } catch {}
}

/**
 * Every box name Sandboxie currently knows about.
 *
 * `SbieApi_EnumBoxes` reports `index + 1` for the box it just filled in and a
 * non-positive value once the enumeration is exhausted — it is not a plain
 * NTSTATUS, which is easy to get wrong (measured).
 */
export function listBoxNames() {
  const a = sbieApi();
  const buffer = Buffer.alloc(34 * 2);
  const names = [];
  for (let index = 0; index < 512; index += 1) {
    buffer.fill(0);
    const status = a.enumBoxes(index, buffer);
    if (status <= 0) break;
    const name = buffer.toString("utf16le").replace(/\0.*$/s, "");
    if (name.length > 0) names.push(name);
  }
  return names;
}

export function boxExists(name) {
  return listBoxNames().some((box) => box.toLowerCase() === name.toLowerCase());
}

/** Ask the engine to re-read `Sandboxie.ini` (`Start.exe /reload` does the same). */
export function reloadConfig() {
  try {
    sbieApi().reloadConf(-1, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SbieIni.exe — configuration writes without an administrator token
// ---------------------------------------------------------------------------

/**
 * Run `SbieIni.exe` and return its trimmed stdout.
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null}}
 */
export function sbieIni(args, options = {}) {
  const result = spawnSync(sbieExe("SbieIni.exe"), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 20000
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status
  };
}

export function queryBoxSetting(box, key) {
  const result = sbieIni(["query", box, key]);
  return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
}

export function setBoxSetting(box, key, value) {
  const result = sbieIni(["set", box, key, value]);
  return result.ok;
}

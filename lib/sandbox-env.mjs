/**
 * Keep Sandboxie able to resolve the user's profile folder when the launcher is
 * started with a trimmed environment.
 *
 * Sandboxie derives the sandbox layout (`user\current`, `ProgramData`, the
 * public profile, ...) from `HKLM\...\ProfileList`, whose `REG_EXPAND_SZ`
 * values it expands with `ExpandEnvironmentStrings` — an API that only sees the
 * *calling process's* environment. DSH's programmatic tool calling deliberately
 * spawns its runtime with a credential-scrubbed environment that keeps only
 * PATH, PATHEXT, SYSTEMROOT, WINDIR, TEMP and TMP. `%SystemDrive%\ProgramData`
 * then cannot be expanded, Sandboxie logs
 *
 *   SBIE2306 Could not locate user directory: [C000003B / 33]
 *   SBIE2304 Initialization of <program> process failed
 *
 * and the boxed relay dies during initialization, so the launcher only reports
 * its connect timeout and every command in the session fails.
 *
 * `SystemDrive` is the one missing piece that is a *system* fact rather than a
 * credential, so the launcher restores it for Sandboxie's bootstrap only. The
 * command itself still receives exactly the environment its caller passed: the
 * relay's spawn spec is built before this module touches `process.env`.
 */

/** `"C:"` / `"c:"` / `"c:\\"` → `"C:"`; anything else → undefined. */
export function normalizeSystemDrive(value) {
  if (typeof value !== "string") return undefined;
  const match = /^\s*([A-Za-z]):\s*$/.exec(value);
  return match === null ? undefined : `${match[1].toUpperCase()}:`;
}

/**
 * Derive the system drive from environment values, a Windows directory path, or
 * a fallback path, in that order.
 *
 * @param env - the environment to read (defaults to the process environment).
 * @param windowsDirectory - a `C:\Windows`-shaped path, or a function returning
 *   one (called only when the environment itself has no drive information).
 */
export function systemDriveFromEnv(env = process.env, windowsDirectory) {
  const direct = normalizeSystemDrive(env.SystemDrive ?? env.SYSTEMDRIVE);
  if (direct !== undefined) return direct;

  const driveOf = (value) => {
    if (typeof value !== "string") return undefined;
    const match = /^\s*([A-Za-z]):[\\/]/.exec(value);
    return match === null ? undefined : `${match[1].toUpperCase()}:`;
  };

  for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
    const drive = driveOf(env[key]);
    if (drive !== undefined) return drive;
  }

  if (windowsDirectory !== undefined) {
    let resolved;
    try {
      resolved = typeof windowsDirectory === "function" ? windowsDirectory() : windowsDirectory;
    } catch {
      resolved = undefined;
    }
    const drive = driveOf(resolved);
    if (drive !== undefined) return drive;
  }

  // Last resort: the drive Node itself lives on (a system fact, not a caller
  // credential) — only reached when even SystemRoot was stripped.
  return driveOf(process.execPath);
}

/**
 * Restore the environment Sandboxie needs to locate the user profile, without
 * touching the command's own spawn specification.
 *
 * @param env - the launcher's process environment (mutated in place; on Windows
 *   that updates the environment block `SbieSvc` reads for the boxed process).
 * @param options.windowsDirectory - see {@link systemDriveFromEnv}.
 * @returns the entries that were added, or undefined when nothing was missing.
 */
export function restoreSandboxieEnvironment(env, options = {}) {
  if (env === undefined) return undefined;
  if (normalizeSystemDrive(env.SystemDrive ?? env.SYSTEMDRIVE) !== undefined) return undefined;

  const drive = systemDriveFromEnv(env, options.windowsDirectory);
  if (drive === undefined) return undefined;
  env.SystemDrive = drive;
  return { SystemDrive: drive };
}

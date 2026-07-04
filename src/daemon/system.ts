/**
 * System operations interface — abstracts OS-level calls for the daemon.
 *
 * Dependency injection boundary: tests can swap MacOSSystem for a mock.
 * All privileged operations (hosts, pf, DNS, browser control) go through this.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface SystemOperations {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  execSilent(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null>;
}

export class MacOSSystem implements SystemOperations {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content);
  }

  /** Write-then-rename for crash safety. */
  async writeFileAtomic(path: string, content: string): Promise<void> {
    const tmp = path + '.tmp';
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, path);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(cmd, args, { timeout: 10000 });
  }

  /** Like exec but returns null instead of throwing on failure. */
  async execSilent(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
    try {
      return await execFileAsync(cmd, args, { timeout: 10000 });
    } catch {
      return null;
    }
  }
}

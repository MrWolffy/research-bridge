import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export function runCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`${executable} ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

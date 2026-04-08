import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { AppSettings } from "../../settings";
import { IEditorLauncher } from "../../domain/ports";

function getOpenCommand(filePath: string, command: string): { bin: string; args: string[] } {
  if (command !== "default") {
    return { bin: command, args: [filePath] };
  }

  switch (platform()) {
    case "darwin":
      return { bin: "open", args: [filePath] };
    case "win32":
      return { bin: "cmd", args: ["/c", "start", "", filePath] };
    default:
      return { bin: "xdg-open", args: [filePath] };
  }
}

export class EditorLauncher implements IEditorLauncher {
  open(filePath: string, settings: AppSettings): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const { bin, args } = getOpenCommand(filePath, settings.editor.command);
      const child = spawn(bin, args, {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          HOME: process.env.HOME ?? homedir(),
        },
      });

      child.once("error", rejectPromise);
      child.once("spawn", () => {
        child.unref();
        resolvePromise();
      });
    });
  }
}


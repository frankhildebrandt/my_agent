import { basename, resolve, sep } from "node:path";
import type { AppSettings } from "../settings";

export function ensurePathString(requestedPath: unknown): string {
  if (typeof requestedPath !== "string") {
    throw new Error("Argument 'path' muss ein String sein.");
  }

  return requestedPath;
}

function normalizeScriptRelativePath(scriptsRoot: string, requestedPath: string): string {
  const trimmedPath = requestedPath.trim().replace(/\\/gu, "/");
  const scriptsDirName = basename(scriptsRoot).replace(/\\/gu, "/");
  const scriptsPrefix = `${scriptsDirName}/`;

  if (trimmedPath === scriptsDirName) {
    return "";
  }

  if (trimmedPath.startsWith(scriptsPrefix)) {
    return trimmedPath.slice(scriptsPrefix.length);
  }

  return trimmedPath;
}

export function resolveScriptPath(
  settings: AppSettings,
  requestedPath: unknown,
): string {
  const requestedPathString = ensurePathString(requestedPath);
  const scriptsRoot = resolve(settings.tools.scriptsDir);
  const normalizedRelativePath = normalizeScriptRelativePath(
    scriptsRoot,
    requestedPathString,
  );

  if (normalizedRelativePath.length === 0) {
    throw new Error("Argument 'path' darf nicht leer sein.");
  }

  const absolutePath = resolve(scriptsRoot, normalizedRelativePath);

  if (
    absolutePath !== scriptsRoot &&
    !absolutePath.startsWith(`${scriptsRoot}${sep}`)
  ) {
    throw new Error("Der Pfad muss innerhalb von tools.scriptsDir liegen.");
  }

  return absolutePath;
}

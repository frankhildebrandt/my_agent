import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function getCandidatePaths(fileName: string): string[] {
  return Array.from(
    new Set([
      resolve(process.cwd(), fileName),
      resolve(__dirname, "..", fileName),
    ]),
  );
}

export function loadDotEnv(fileName = ".env"): string | null {
  const envPath = getCandidatePaths(fileName).find((candidatePath) => existsSync(candidatePath));

  if (!envPath) {
    return null;
  }

  const content = readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/u);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmedLine.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const rawValue = trimmedLine.slice(equalsIndex + 1).trim();

    if (key.length === 0 || key in process.env) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue);
  }

  return envPath;
}

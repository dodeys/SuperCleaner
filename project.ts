import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve, relative, basename, extname } from "path";

const ENTRY_BASENAMES = new Set([
  "index.ts",
  "index.js",
  "index.tsx",
  "index.jsx",
  "main.ts",
  "main.js",
  "app.ts",
  "app.js",
  "worker.ts",
  "worker.js",
]);

const PROTECTED_BASENAMES = new Set([
  "app.d.ts",
  "hooks.server.ts",
  "hooks.client.ts",
  "hooks.ts",
  "app.html",
]);

/**
 * Walk upward from a scan path until a package manifest is found.
 */
export function findProjectRoot(scanPath: string): string {
  let current = resolve(scanPath);
  const stat = existsSync(current) ? readPathStat(current) : null;
  if (stat === "file") {
    current = dirname(current);
  }

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(scanPath);
    }
    current = parent;
  }
}

function readPathStat(path: string): "file" | "directory" {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "directory";
  }
}

/**
 * Built-in path aliases common in Vite / SvelteKit / Workers projects.
 */
export function buildDefaultAliases(projectRoot: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const srcRoot = join(projectRoot, "src");

  aliases.set("$lib", join(srcRoot, "lib"));
  aliases.set("$app", join(srcRoot, "lib")); // fallback; $app modules are usually virtual
  aliases.set("$env", join(srcRoot, "env"));
  aliases.set("@", srcRoot);
  aliases.set("~", srcRoot);

  const tsconfigPaths = readTsconfigPaths(projectRoot);
  for (const [key, target] of tsconfigPaths) {
    aliases.set(key.replace(/\/\*$/, ""), target.replace(/\/\*$/, ""));
  }

  return aliases;
}

function readTsconfigPaths(projectRoot: string): Map<string, string> {
  const paths = new Map<string, string>();
  const candidates = ["tsconfig.json", "tsconfig.app.json"];

  for (const fileName of candidates) {
    const configPath = join(projectRoot, fileName);
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, "utf-8");
      const json = JSON.parse(stripJsonComments(raw)) as {
        compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
      };
      const compilerPaths = json.compilerOptions?.paths;
      if (!compilerPaths) continue;

      const baseUrl = resolve(projectRoot, json.compilerOptions?.baseUrl ?? ".");

      for (const [aliasKey, targets] of Object.entries(compilerPaths)) {
        const target = targets[0];
        if (!target) continue;
        const absolute = resolve(baseUrl, target.replace(/\/\*$/, ""));
        paths.set(aliasKey.replace(/\/\*$/, ""), absolute);
      }
    } catch {
      // ignore invalid tsconfig
    }
  }

  return paths;
}

function stripJsonComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export function isProtectedFile(filePath: string): boolean {
  const name = basename(filePath);
  if (PROTECTED_BASENAMES.has(name)) return true;
  if (filePath.endsWith(".d.ts")) return true;
  if (name.startsWith("+")) return true;
  if (filePath.includes("/.supercleaner-backup/")) return true;
  return false;
}

export function isEntryPointFile(filePath: string, projectRoot: string): boolean {
  const name = basename(filePath);
  if (name.startsWith("+")) return true;
  if (PROTECTED_BASENAMES.has(name)) return true;

  const rel = relative(projectRoot, filePath).replace(/\\/g, "/");

  if (ENTRY_BASENAMES.has(name)) {
    if (rel.startsWith("src/") || rel === name) return true;
  }

  if (/\/(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) {
    return true;
  }

  return false;
}

export function isExternalModule(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("$") &&
    !specifier.startsWith("@/") &&
    !specifier.startsWith("~/") &&
    !specifier.startsWith("src/")
  );
}

const FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".svelte", ".mjs", ".cjs"];

/**
 * Resolve a module specifier to an on-disk file inside the project, if possible.
 */
export function resolveImportPath(
  importingFile: string,
  importSource: string,
  allProjectFiles: string[],
  projectRoot: string,
  aliases: Map<string, string>
): string | null {
  if (isExternalModule(importSource)) {
    return null;
  }

  let targetPath = "";

  if (importSource.startsWith("@/")) {
    targetPath = resolve(projectRoot, "src", importSource.slice(2));
  } else if (importSource.startsWith("~/")) {
    targetPath = resolve(projectRoot, "src", importSource.slice(2));
  } else if (importSource.startsWith("src/")) {
    targetPath = resolve(projectRoot, importSource);
  } else if (importSource.startsWith("$")) {
    const aliasEntry = [...aliases.entries()].find(([prefix]) =>
      importSource === prefix || importSource.startsWith(`${prefix}/`)
    );
    if (!aliasEntry) return null;
    const [prefix, baseDir] = aliasEntry;
    const remainder = importSource.slice(prefix.length).replace(/^\//, "");
    targetPath = resolve(baseDir, remainder);
  } else {
    targetPath = resolve(dirname(importingFile), importSource);
  }

  const resolved = resolveExistingFile(targetPath);
  if (resolved && allProjectFiles.includes(resolved)) {
    return resolved;
  }

  // Allow resolving into project even if outside the current scan folder
  if (resolved && resolved.startsWith(projectRoot)) {
    return resolved;
  }

  return null;
}

function resolveExistingFile(basePath: string): string | null {
  if (existsSync(basePath)) {
    const ext = extname(basePath);
    if (ext && FILE_EXTENSIONS.includes(ext)) {
      return resolve(basePath);
    }
  }

  const suffixes = [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".svelte",
    "/index.ts",
    "/index.js",
    "/index.tsx",
    "/index.jsx",
  ];

  for (const suffix of suffixes) {
    const candidate = basePath + suffix;
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  return null;
}

import ts from "typescript";
import { join, dirname, resolve, extname } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";

export interface ImportBinding {
  name: string;
  start: number;
  end: number;
}

export interface ImportDeclarationInfo {
  moduleSpecifier: string;
  bindings: ImportBinding[];
  unusedBindings: ImportBinding[];
  start: number;
  end: number;
  fullText: string;
}

export interface LocalDeclaration {
  name: string;
  kind: "variable" | "function" | "class" | "interface" | "type" | "enum";
  start: number;
  end: number;
  isExported: boolean;
  unused: boolean;
}

export interface CSSSelectorInfo {
  selector: string;
  classes: string[];
  ids: string[];
  start: number;
  end: number;
}

export interface SvelteParts {
  script: { content: string; start: number; end: number; lang: string }[];
  style: { content: string; start: number; end: number } | null;
  template: string;
}

export interface FileAnalysis {
  filePath: string;
  imports: ImportDeclarationInfo[];
  localDeclarations: LocalDeclaration[];
  unusedCSSSelectors: string[];
  exports: string[]; // List of names exported by this file
}

/**
 * Extracts script, style, and template parts from a Svelte file.
 */
export function parseSvelte(content: string): SvelteParts {
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

  const scripts: SvelteParts["script"] = [];
  let match;
  while ((match = scriptRegex.exec(content)) !== null) {
    const attrs = match[1] || "";
    const langMatch = attrs.match(/lang=["']([^"']+)["']/i);
    const lang = langMatch ? langMatch[1] : "js";
    scripts.push({
      content: match[2],
      start: match.index + match[0].indexOf(match[2]),
      end: match.index + match[0].indexOf(match[2]) + match[2].length,
      lang,
    });
  }

  styleRegex.lastIndex = 0;
  const styleMatch = styleRegex.exec(content);
  let style: SvelteParts["style"] = null;
  if (styleMatch) {
    const innerContent = styleMatch[1];
    const startIndex = styleMatch.index + styleMatch[0].indexOf(innerContent);
    style = {
      content: innerContent,
      start: startIndex,
      end: startIndex + innerContent.length,
    };
  }

  // Template is everything except script and style tags
  const template = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  return { scripts, style, template };
}

/**
 * Checks if a given TS identifier is a reference to a variable,
 * or simply its declaration name or property key.
 */
function isNodeAReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;

  // Declaration names are NOT references
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) && parent.name === node) return false;
  if (ts.isImportClause(parent) && parent.name === node) return false;
  if (ts.isNamespaceImport(parent) && parent.name === node) return false;

  // Property access on objects: e.g. user.name (name is not a variable reference)
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  // Key names in object declarations: e.g. { name: "John" } (name is key, not reference)
  // Note: Short-hand properties like { name } ARE references, and ts.isShorthandPropertyAssignment(parent) handles it as a reference
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;

  // TS types and Jsx properties
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;

  return true;
}

/**
 * Extracts identifiers from destructuring patterns.
 */
function extractIdentifiersFromPattern(nameNode: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(nameNode)) {
    return [nameNode];
  }
  const identifiers: ts.Identifier[] = [];
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        identifiers.push(...extractIdentifiersFromPattern(element.name));
      }
    }
  }
  return identifiers;
}

/**
 * Checks if a declaration statement is exported.
 */
function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers) {
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  if (node.parent && ts.isVariableDeclarationList(node.parent)) {
    return isExported(node.parent.parent);
  }
  return false;
}

/**
 * Parsers a CSS stylesheet and extracts selectors with their classes and IDs.
 */
export function extractCSSSelectors(css: string): CSSSelectorInfo[] {
  const selectors: CSSSelectorInfo[] = [];
  // Basic regex to find selector blocks e.g. .card, .btn { color: red; }
  const ruleRegex = /([^{]+)\{([^}]+)\}/gi;
  let match;

  while ((match = ruleRegex.exec(css)) !== null) {
    const rawSelectors = match[1].trim();
    const start = match.index;
    const end = match.index + rawSelectors.length;

    // Split multiple comma-separated selectors (e.g., .card, button)
    const list = rawSelectors.split(",").map((s) => s.trim());
    for (const item of list) {
      if (!item) continue;

      // Find CSS classes e.g. .button-active
      const classRegex = /\.([a-zA-Z0-9_-]+)/g;
      const classes: string[] = [];
      let classMatch;
      while ((classMatch = classRegex.exec(item)) !== null) {
        classes.push(classMatch[1]);
      }

      // Find CSS IDs e.g. #main-container
      const idRegex = /#([a-zA-Z0-9_-]+)/g;
      const ids: string[] = [];
      let idMatch;
      while ((idMatch = idRegex.exec(item)) !== null) {
        ids.push(idMatch[1]);
      }

      selectors.push({
        selector: item,
        classes,
        ids,
        start,
        end,
      });
    }
  }

  return selectors;
}

/**
 * Core function to parse and analyze a TS, JS, or Svelte file.
 */
export function analyzeFile(filePath: string, fileContent: string): FileAnalysis {
  const isSvelte = filePath.endsWith(".svelte");
  let scriptContent = fileContent;
  let svelteStyle: SvelteParts["style"] = null;
  let svelteTemplate = "";

  if (isSvelte) {
    const svelteParts = parseSvelte(fileContent);
    // Combine all script blocks for simplicity of reference analysis, or use the main one.
    scriptContent = svelteParts.scripts.map((s) => s.content).join("\n\n");
    svelteStyle = svelteParts.style;
    svelteTemplate = svelteParts.template;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    scriptContent,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );

  const imports: ImportDeclarationInfo[] = [];
  const localDeclarations: LocalDeclaration[] = [];
  const exports: string[] = [];
  const references = new Map<string, number[]>(); // Tracks positions of referenced identifier texts

  // Step 1: Walk AST to collect all identifier references
  function collectReferences(node: ts.Node) {
    if (ts.isIdentifier(node) && isNodeAReference(node)) {
      const name = node.text;
      const list = references.get(name) || [];
      list.push(node.getStart(sourceFile));
      references.set(name, list);
    }
    node.forEachChild(collectReferences);
  }
  collectReferences(sourceFile);

  // Step 2: Walk AST to collect Imports and Declarations
  function walkAST(node: ts.Node) {
    // 1. Imports
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");
      const bindings: ImportBinding[] = [];

      if (node.importClause) {
        // Default import: import Default from 'module'
        if (node.importClause.name) {
          bindings.push({
            name: node.importClause.name.text,
            start: node.importClause.name.getStart(sourceFile),
            end: node.importClause.name.getEnd(),
          });
        }

        // Named bindings
        if (node.importClause.namedBindings) {
          const named = node.importClause.namedBindings;
          if (ts.isNamespaceImport(named)) {
            // import * as ns from 'module'
            bindings.push({
              name: named.name.text,
              start: named.name.getStart(sourceFile),
              end: named.name.getEnd(),
            });
          } else if (ts.isNamedImports(named)) {
            // import { a, b as c } from 'module'
            for (const elem of named.elements) {
              bindings.push({
                name: elem.name.text,
                start: elem.name.getStart(sourceFile),
                end: elem.name.getEnd(),
              });
            }
          }
        }
      }

      imports.push({
        moduleSpecifier,
        bindings,
        unusedBindings: [],
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        fullText: node.getText(sourceFile),
      });
    }

    // 2. Declarations
    let declName: ts.BindingName | undefined = undefined;
    let kind: LocalDeclaration["kind"] | null = null;

    if (ts.isVariableDeclaration(node)) {
      declName = node.name;
      kind = "variable";
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      declName = node.name;
      kind = "function";
    } else if (ts.isClassDeclaration(node) && node.name) {
      declName = node.name;
      kind = "class";
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      declName = node.name;
      kind = "interface";
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      declName = node.name;
      kind = "type";
    } else if (ts.isEnumDeclaration(node) && node.name) {
      declName = node.name;
      kind = "enum";
    }

    if (declName && kind) {
      const isDeclExported = isExported(node);
      const idNodes = extractIdentifiersFromPattern(declName);

      for (const idNode of idNodes) {
        const name = idNode.text;
        if (isDeclExported) {
          exports.push(name);
        }

        localDeclarations.push({
          name,
          kind,
          start: idNode.getStart(sourceFile),
          end: idNode.getEnd(),
          isExported: isDeclExported,
          unused: false, // will compute below
        });
      }
    }

    node.forEachChild(walkAST);
  }
  walkAST(sourceFile);

  // Step 3: Compute unused bindings and declarations
  for (const imp of imports) {
    imp.unusedBindings = imp.bindings.filter((binding) => {
      const refs = references.get(binding.name) || [];
      // If it's a Svelte file, also check template usage
      const usedInTemplate = isSvelte && new RegExp(`\\b${binding.name}\\b`).test(svelteTemplate);
      return refs.length === 0 && !usedInTemplate;
    });
  }

  for (const decl of localDeclarations) {
    if (!decl.isExported) {
      const refs = references.get(decl.name) || [];
      // Exclude references that fall inside its own definition coordinates
      const actualRefs = refs.filter((pos) => pos < decl.start || pos > decl.end);
      const usedInTemplate = isSvelte && new RegExp(`\\b${decl.name}\\b`).test(svelteTemplate);
      decl.unused = actualRefs.length === 0 && !usedInTemplate;
    }
  }

  // Step 4: Analyze unused CSS selectors for Svelte
  const unusedCSSSelectors: string[] = [];
  if (isSvelte && svelteStyle) {
    const cssSelectors = extractCSSSelectors(svelteStyle.content);
    for (const item of cssSelectors) {
      let isSelectorUsed = false;

      // Check if any class inside selector is used
      const hasClasses = item.classes.length > 0;
      const classesUsed = item.classes.some((className) => {
        // Matches class="name", class:name, or class:name={...} or class:name_active
        const classRegex = new RegExp(`class\\s*:\\s*${className}\\b|class\\s*=\\s*["'][^"']*?\\b${className}\\b`, "i");
        return classRegex.test(svelteTemplate);
      });

      // Check if ID inside selector is used
      const hasIds = item.ids.length > 0;
      const idsUsed = item.ids.some((idName) => {
        const idRegex = new RegExp(`id\\s*=\\s*["'][^"']*?\\b${idName}\\b`, "i");
        return idRegex.test(svelteTemplate);
      });

      // Heuristic: If it has classes or IDs, check if they are matched in template.
      // If it doesn't have classes or IDs (e.g. `div`, `p`), we assume it is used to avoid false positives on elements.
      if (hasClasses || hasIds) {
        isSelectorUsed = (hasClasses ? classesUsed : true) && (hasIds ? idsUsed : true);
      } else {
        isSelectorUsed = true; // safe fallback for tag selectors e.g., "h1" or "p"
      }

      if (!isSelectorUsed) {
        unusedCSSSelectors.push(item.selector);
      }
    }
  }

  return {
    filePath,
    imports,
    localDeclarations,
    unusedCSSSelectors,
    exports,
  };
}

export function scanFiles(dirPath: string, rootPath: string = dirPath): string[] {
  const fileList: string[] = [];
  
  // Exclude patterns for folders
  const excludes = [
    "node_modules",
    ".git",
    ".wrangler",
    ".svelte-kit",
    "dist",
    "build"
  ];

  // Exclude patterns for specific system files
  const fileExcludes = [
    "eslint.config.js",
    "eslint.config.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "vitest.config.js",
    "wrangler.jsonc",
    "wrangler.json",
    "svelte.config.js",
    "tsconfig.json",
    "tailwind.config.js"
  ];

  function recurse(currentDir: string) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      return; // Directory not accessible
    }

    for (const entry of entries) {
      const name = entry.name;
      if (excludes.includes(name)) continue;

      const fullPath = resolve(currentDir, name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile()) {
        if (name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".svelte")) {
          if (!fileExcludes.includes(name) && !name.endsWith(".tsconfig.json")) {
            fileList.push(fullPath);
          }
        }
      }
    }
  }

  recurse(dirPath);
  return fileList;
}

/**
 * Resolves an import source path to its actual file path.
 */
export function resolveImportPath(
  importingFile: string,
  importSource: string,
  allProjectFiles: string[],
  projectRoot: string
): string | null {
  // If it's a module from node_modules, ignore
  if (!importSource.startsWith(".") && !importSource.startsWith("$lib/") && !importSource.startsWith("src/")) {
    return null;
  }

  let targetPath = "";
  if (importSource.startsWith("$lib/")) {
    // SvelteKit alias $lib -> src/lib
    targetPath = resolve(projectRoot, "src/lib", importSource.slice(5));
  } else if (importSource.startsWith("src/")) {
    targetPath = resolve(projectRoot, importSource);
  } else {
    // Relative path
    targetPath = resolve(dirname(importingFile), importSource);
  }

  // Extensions to check
  const extensions = [".ts", ".js", ".svelte", "/index.ts", "/index.js"];
  
  // Try resolving with ext
  if (existsSync(targetPath) && extname(targetPath)) {
    return targetPath;
  }

  for (const ext of extensions) {
    const pathWithExt = targetPath + ext;
    if (existsSync(pathWithExt)) {
      return pathWithExt;
    }
  }

  return null;
}

/**
 * Builds the import graph and returns a list of "Dead Files" (0 imports).
 * Excludes standard SvelteKit routing pages starting with '+' and main entry points.
 */
export function detectDeadFiles(
  projectFiles: string[],
  projectRoot: string
): { deadFiles: string[]; importGraph: Map<string, string[]> } {
  const importGraph = new Map<string, string[]>(); // Map of file -> list of files it imports
  const inDegree = new Map<string, number>(); // Map of file -> number of other files importing it

  // Initialize in-degree map
  for (const file of projectFiles) {
    inDegree.set(file, 0);
    importGraph.set(file, []);
  }

  // Build the graph
  for (const file of projectFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const isSvelte = file.endsWith(".svelte");
      let scriptContent = content;

      if (isSvelte) {
        const parts = parseSvelte(content);
        scriptContent = parts.scripts.map((s) => s.content).join("\n\n");
      }

      // Regex for static imports: import ... from "module" or import "module"
      const staticImportRegex = /(?:import|export)\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/gi;
      let match;
      const imports: string[] = [];

      while ((match = staticImportRegex.exec(scriptContent)) !== null) {
        imports.push(match[1]);
      }

      // Regex for dynamic imports: import("module")
      const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;
      while ((match = dynamicImportRegex.exec(scriptContent)) !== null) {
        imports.push(match[1]);
      }

      const uniqueImports = Array.from(new Set(imports));
      const resolvedPaths: string[] = [];

      for (const imp of uniqueImports) {
        const resolved = resolveImportPath(file, imp, projectFiles, projectRoot);
        if (resolved && projectFiles.includes(resolved)) {
          resolvedPaths.push(resolved);
          inDegree.set(resolved, (inDegree.get(resolved) || 0) + 1);
        }
      }

      importGraph.set(file, resolvedPaths);
    } catch (e) {
      // Ignore reading/parsing failures for individual files
    }
  }

  // Filter out files with 0 in-degree that are entry points
  const deadFiles: string[] = [];
  for (const [file, count] of inDegree.entries()) {
    if (count === 0) {
      const basename = file.split("/").pop() || "";
      
      // SvelteKit route files starting with + (e.g., +page.svelte, +layout.svelte, etc.) are entry points
      const isSvelteKitRoute = basename.startsWith("+");
      
      // Standard entrypoint paths for Workers/Vite
      const isEntrypoint = 
        file.endsWith("src/index.ts") || 
        file.endsWith("src/index.js") || 
        file.endsWith("src/app.html") || 
        file.includes("/test/") || 
        file.includes(".test.") || 
        file.includes(".spec.");

      if (!isSvelteKitRoute && !isEntrypoint) {
        deadFiles.push(file);
      }
    }
  }

  return {
    deadFiles,
    importGraph,
  };
}

/**
 * Detects exported variables/functions/classes that are never imported anywhere.
 */
export function detectDeadExports(
  projectFiles: string[],
  projectRoot: string,
  fileAnalyses: FileAnalysis[]
): { filePath: string; deadExportName: string }[] {
  const deadExports: { filePath: string; deadExportName: string }[] = [];
  
  // Map of export name -> set of files that export it
  const exportToFiles = new Map<string, string[]>();
  for (const analysis of fileAnalyses) {
    for (const exp of analysis.exports) {
      const list = exportToFiles.get(exp) || [];
      list.push(analysis.filePath);
      exportToFiles.set(exp, list);
    }
  }

  // To check if exports are imported:
  // We scan all file contents for occurrences of the exported names
  // excluding the files that actually export them.
  for (const [expName, files] of exportToFiles.entries()) {
    let isImported = false;

    for (const projectFile of projectFiles) {
      // Skip files that export this identifier
      if (files.includes(projectFile)) continue;

      try {
        const content = readFileSync(projectFile, "utf-8");
        // Check if the export name is imported: e.g. import { expName } from '...'
        // A very robust heuristic: matches name inside imports or anywhere in file if it's imported
        if (content.includes(expName)) {
          // Verify with a word boundary to avoid false positives e.g., "myExport" matching "myExportedVar"
          const wordRegex = new RegExp(`\\b${expName}\\b`);
          if (wordRegex.test(content)) {
            isImported = true;
            break;
          }
        }
      } catch (e) {
        // ignore read error
      }
    }

    if (!isImported) {
      for (const file of files) {
        deadExports.push({
          filePath: file,
          deadExportName: expName,
        });
      }
    }
  }

  return deadExports;
}

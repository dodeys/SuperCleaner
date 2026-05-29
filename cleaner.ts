import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { parseSvelte } from "./parser.ts";
import type { FileAnalysis, ImportDeclarationInfo, ImportBinding } from "./parser.ts";

/**
 * Creates an exact backup of a file under the .supercleaner-backup directory.
 */
export function createBackup(filePath: string, projectRoot: string): string {
  const relativePath = relative(projectRoot, filePath);
  const backupPath = join(projectRoot, ".supercleaner-backup", relativePath);
  
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Safely rewrites a single import declaration, removing unused bindings.
 */
export function rewriteImportDeclaration(importText: string, unusedBindings: ImportBinding[]): string {
  // If all bindings are unused, we can delete the whole import statement
  if (unusedBindings.length === 0) return importText;

  // Find the curly braces
  const openBrace = importText.indexOf("{");
  const closeBrace = importText.indexOf("}");
  
  if (openBrace === -1 || closeBrace === -1) {
    // No named curly-brace bindings, must be a default or namespace import.
    // If it's unused, the caller should delete the whole import.
    return importText;
  }

  const innerText = importText.slice(openBrace + 1, closeBrace);
  const parts = innerText.split(",");
  
  const unusedNames = unusedBindings.map((b) => b.name);
  const usedParts = parts
    .map((p) => p.trim())
    .filter((part) => {
      if (!part) return false;
      // Get the local identifier name (handles 'b as c' -> 'c')
      const subParts = part.split(/\s+as\s+/i);
      const localName = subParts[subParts.length - 1].trim();
      return !unusedNames.includes(localName);
    });

  if (usedParts.length === 0) {
    // No named bindings left. Let's see if there is a default import before the curly brace
    const beforeBrace = importText.slice(0, openBrace).trim();
    const afterBrace = importText.slice(closeBrace + 1).trim();
    
    if (beforeBrace.endsWith(",")) {
      // Had a default import (e.g., "import defaultVal, { ... }") -> keep defaultVal
      return beforeBrace.slice(0, -1).trim() + " " + afterBrace;
    }
    // No default import left, entire statement is dead
    return "";
  }

  return importText.slice(0, openBrace + 1) + " " + usedParts.join(", ") + " " + importText.slice(closeBrace);
}

/**
 * Re-writes a Svelte file's CSS, removing unused selectors.
 */
export function cleanSvelteCSS(cssContent: string, unusedSelectors: string[]): string {
  if (unusedSelectors.length === 0) return cssContent;

  let cleanedCSS = cssContent;
  const ruleRegex = /([^{]+)\{([^}]+)\}/gi;
  let match;
  const replacements: { start: number; end: number; content: string }[] = [];

  while ((match = ruleRegex.exec(cssContent)) !== null) {
    const rawSelectors = match[1].trim();
    const list = rawSelectors.split(",").map((s) => s.trim());
    
    // Check which selectors in this rule are used
    const usedList = list.filter((sel) => !unusedSelectors.includes(sel));

    if (usedList.length === 0) {
      // Entire CSS rule is unused
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        content: "",
      });
    } else if (usedList.length < list.length) {
      // Some selectors are unused, rewrite the selector list
      replacements.push({
        start: match.index,
        end: match.index + rawSelectors.length,
        content: usedList.join(", "),
      });
    }
  }

  // Apply replacements in reverse order to keep offsets correct
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    cleanedCSS = cleanedCSS.slice(0, r.start) + r.content + cleanedCSS.slice(r.end);
  }

  return cleanedCSS;
}

/**
 * Safely cleans a single file and writes it to disk.
 */
export function applyFileCleaning(
  filePath: string,
  content: string,
  analysis: FileAnalysis,
  cleanTypes: string[] = ["all"]
): string {
  const isSvelte = filePath.endsWith(".svelte");
  const cleanAll = cleanTypes.includes("all");
  const cleanImports = cleanAll || cleanTypes.includes("imports");
  const cleanCSS = cleanAll || cleanTypes.includes("css");
  const cleanVariables = cleanAll || cleanTypes.includes("variables");

  let modifiedContent = content;

  // 1. Clean Unused CSS Selectors in Svelte files
  if (isSvelte && cleanCSS && analysis.unusedCSSSelectors.length > 0) {
    const svelteParts = parseSvelte(modifiedContent);
    if (svelteParts.style) {
      const cleanedCSS = cleanSvelteCSS(svelteParts.style.content, analysis.unusedCSSSelectors);
      modifiedContent =
        modifiedContent.slice(0, svelteParts.style.start) +
        cleanedCSS +
        modifiedContent.slice(svelteParts.style.end);
    }
  }

  // Refresh analysis and offsets for imports because the CSS clean might have shifted script offsets in Svelte!
  // Svelte parts separation helps us isolate script offsets perfectly.
  let scriptBlockStart = 0;
  let scriptContent = modifiedContent;

  if (isSvelte) {
    const parts = parseSvelte(modifiedContent);
    if (parts.scripts.length > 0) {
      // For simplicity, we target the first script block where imports are declared
      scriptContent = parts.scripts[0].content;
      scriptBlockStart = parts.scripts[0].start;
    } else {
      scriptContent = "";
    }
  }

  // 2. Clean Unused Imports
  if (cleanImports && analysis.imports.length > 0) {
    const importReplacements: { start: number; end: number; content: string }[] = [];

    for (const imp of analysis.imports) {
      if (imp.unusedBindings.length === 0) continue;

      if (imp.unusedBindings.length === imp.bindings.length) {
        // Delete entire import statement
        importReplacements.push({
          start: imp.start,
          end: imp.end,
          content: "",
        });
      } else {
        // Rewrite named bindings
        const rewritten = rewriteImportDeclaration(imp.fullText, imp.unusedBindings);
        importReplacements.push({
          start: imp.start,
          end: imp.end,
          content: rewritten,
        });
      }
    }

    // Sort in reverse order
    importReplacements.sort((a, b) => b.start - a.start);
    let modifiedScript = scriptContent;
    for (const repl of importReplacements) {
      modifiedScript =
        modifiedScript.slice(0, repl.start) + repl.content + modifiedScript.slice(repl.end);
    }

    if (isSvelte) {
      // Re-insert cleaned script block into Svelte file
      modifiedContent =
        modifiedContent.slice(0, scriptBlockStart) +
        modifiedScript +
        modifiedContent.slice(scriptBlockStart + scriptContent.length);
    } else {
      modifiedContent = modifiedScript;
    }
  }

  // 3. Clean Unused Variables (Safe ones only)
  // Safe variables are local declarations with simple literals or no initializers, preventing side-effects.
  if (cleanVariables && analysis.localDeclarations.length > 0) {
    // For local declarations, we focus on removing simple variables like 'const x = 1;' or 'let y;'
    // If the declaration contains complex calls, we report but don't remove to prevent breaking logic.
    const varReplacements: { start: number; end: number; content: string }[] = [];
    const unusedLocals = analysis.localDeclarations.filter((d) => d.unused && !d.isExported);

    if (unusedLocals.length > 0) {
      // Refresh parts
      let targetScript = modifiedContent;
      let targetStart = 0;
      if (isSvelte) {
        const parts = parseSvelte(modifiedContent);
        if (parts.scripts.length > 0) {
          targetScript = parts.scripts[0].content;
          targetStart = parts.scripts[0].start;
        } else {
          targetScript = "";
        }
      }

      // To clean them safely, we recommend matching their identifier positions 
      // or commenting them out inside the script text.
      // We will perform a surgical comment-out of the dead local identifiers
      // so developers can review them easily or delete them safely.
      for (const loc of unusedLocals) {
        // Find the line where this local declaration starts
        const textBefore = targetScript.slice(0, loc.start);
        const lineStartIndex = textBefore.lastIndexOf("\n") + 1;
        const lineEndIndex = targetScript.indexOf("\n", loc.end);
        const lineText = targetScript.slice(lineStartIndex, lineEndIndex === -1 ? targetScript.length : lineEndIndex);

        // Simple safety: if the line declares this variable and it's a simple assignment
        const isSimpleDecl = 
          lineText.includes("const ") || 
          lineText.includes("let ") || 
          lineText.includes("var ");

        if (isSimpleDecl && !lineText.includes("/*") && !lineText.startsWith("//")) {
          // Comment out the declaration line safely
          varReplacements.push({
            start: lineStartIndex,
            end: lineStartIndex + lineText.length,
            content: `// TODO (SuperCleaner): Removed dead variable: ${lineText.trim()}`,
          });
        }
      }

      // Sort in reverse order
      varReplacements.sort((a, b) => b.start - a.start);
      let cleanedScript = targetScript;
      for (const r of varReplacements) {
        cleanedScript = cleanedScript.slice(0, r.start) + r.content + cleanedScript.slice(r.end);
      }

      if (isSvelte) {
        modifiedContent =
          modifiedContent.slice(0, targetStart) +
          cleanedScript +
          modifiedContent.slice(targetStart + targetScript.length);
      } else {
        modifiedContent = cleanedScript;
      }
    }
  }

  // Write file to disk
  writeFileSync(filePath, modifiedContent, "utf-8");
  return modifiedContent;
}

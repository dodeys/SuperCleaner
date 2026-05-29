import { existsSync, readFileSync, statSync, unlinkSync, readSync } from "fs";
import { resolve, relative, basename } from "path";
import { scanFiles, analyzeFile, detectDeadFiles, detectDeadExports } from "./parser.ts";
import type { FileAnalysis } from "./parser.ts";
import { createBackup, applyFileCleaning } from "./cleaner.ts";

// ANSI Terminal Colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bgBlack: "\x1b[40m",
  bgCyan: "\x1b[46m",
  black: "\x1b[30m",
};

/**
 * Format file size into human-readable bytes
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Universally compatible synchronous prompt for reading from stdin
 * Works seamlessly in both Bun and standard Node.js ES Modules.
 */
function readlinePrompt(query: string): string {
  if (typeof prompt === "function") {
    try {
      const res = prompt(query);
      if (res !== null && res !== undefined) return res;
    } catch (e) {}
  }

  process.stdout.write(query);
  const buffer = Buffer.alloc(1024);
  let bytesRead = 0;
  try {
    bytesRead = readSync(0, buffer, 0, 1024, null);
  } catch (e) {
    return "";
  }
  return buffer.subarray(0, bytesRead).toString().trim();
}

async function main() {
  const args = typeof Bun !== "undefined" ? Bun.argv : process.argv;
  
  // Default configurations
  let targetPath = process.cwd();
  let dryRun = true;
  let cleanTypes: string[] = ["all"];
  let backupEnabled = true;

  // Manual argument parsing
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--clean") {
      dryRun = false;
    } else if (arg === "--path" && args[i + 1]) {
      targetPath = resolve(process.cwd(), args[i + 1]);
      i++;
    } else if (arg === "--type" && args[i + 1]) {
      cleanTypes = args[i + 1].split(",").map((t) => t.trim());
      i++;
    } else if (arg === "--no-backup") {
      backupEnabled = false;
    }
  }

  // Header Card
  console.log(`\n${c.cyan}============================================================${c.reset}`);
  console.log(`${c.cyan}                        ${c.bold}${c.green}SUPER CLEANER${c.reset}${c.cyan}                       ║${c.reset}`);
  console.log(`${c.cyan}           ${c.dim}Dead Code Removal Utility for TS & Svelte${c.reset}${c.cyan}        ║${c.reset}`);
  console.log(`${c.cyan}============================================================${c.reset}\n`);

  if (!existsSync(targetPath)) {
    console.log(`${c.red}Error: The specified path does not exist:${c.reset} ${targetPath}`);
    process.exit(1);
  }

  const stat = statSync(targetPath);
  let isSingleFile = !stat.isDirectory();
  let filesToScan: string[] = [];
  let rootFolder = isSingleFile ? resolve(targetPath, "..") : targetPath;

  if (isSingleFile) {
    filesToScan = [targetPath];
    console.log(`${c.yellow}Analyzing single file:${c.reset} ${relative(process.cwd(), targetPath)}`);
  } else {
    console.log(`${c.yellow}Scanning directory for TS/Svelte files...${c.reset}`);
    filesToScan = scanFiles(targetPath);
    console.log(`${c.green}Found ${filesToScan.length} files to analyze in ${relative(process.cwd(), targetPath)}.${c.reset}\n`);
  }

  if (filesToScan.length === 0) {
    console.log(`${c.yellow}No relevant TypeScript or Svelte files found in the target path.${c.reset}`);
    process.exit(0);
  }

  // --- Step 1: Analyze Files ---
  console.log(`${c.blue}Analyzing variable and import references...${c.reset}`);
  const analyses: FileAnalysis[] = [];
  let totalImportsFound = 0;
  let totalUnusedImports = 0;
  let totalLocalVars = 0;
  let totalUnusedVars = 0;
  let totalCSSSelectors = 0;
  let totalUnusedCSS = 0;

  for (const file of filesToScan) {
    try {
      const content = readFileSync(file, "utf-8");
      const analysis = analyzeFile(file, content);
      analyses.push(analysis);

      // Aggregate stats
      analysis.imports.forEach((imp) => {
        totalImportsFound += imp.bindings.length;
        totalUnusedImports += imp.unusedBindings.length;
      });

      analysis.localDeclarations.forEach((decl) => {
        if (!decl.isExported) {
          totalLocalVars++;
          if (decl.unused) totalUnusedVars++;
        }
      });

      totalUnusedCSS += analysis.unusedCSSSelectors.length;
    } catch (e) {
      console.log(`${c.red}Error reading or analyzing file:${c.reset} ${basename(file)} - ${e}`);
    }
  }

  // --- Step 2: Detect Dead Files & Dead Exports ---
  let deadFiles: string[] = [];
  let deadExports: { filePath: string; deadExportName: string }[] = [];

  if (!isSingleFile) {
    console.log(`${c.blue}Resolving import graph and public exports...${c.reset}`);
    const deadFilesResult = detectDeadFiles(filesToScan, rootFolder);
    deadFiles = deadFilesResult.deadFiles;

    deadExports = detectDeadExports(filesToScan, rootFolder, analyses);
  }

  console.log(`\n${c.bold}${c.cyan}SCAN SUMMARY (DRY RUN)${c.reset}`);
  console.log(`${c.gray}─${c.reset}`.repeat(60));
  console.log(`Files scanned: ${filesToScan.length}`);
  console.log(`Imports evaluated: ${totalImportsFound} (${c.red}${totalUnusedImports} unused${c.reset})`);
  console.log(`Local variables: ${totalLocalVars} (${c.red}${totalUnusedVars} unused${c.reset})`);
  console.log(`Svelte CSS selectors: ${totalUnusedCSS} obsolete`);
  
  if (!isSingleFile) {
    console.log(`Dead exports: ${c.red}${deadExports.length} exported but never imported${c.reset}`);
    console.log(`Orphan files (dead): ${c.red}${deadFiles.length} unconnected to project${c.reset}`);
  }
  console.log(`${c.gray}─${c.reset}`.repeat(60) + "\n");

  // --- Step 3: Detailed Report ---
  let fileHasIssues = false;

  for (const analysis of analyses) {
    const fileRel = relative(rootFolder, analysis.filePath);
    const unusedImps = analysis.imports.filter((i) => i.unusedBindings.length > 0);
    const unusedLocals = analysis.localDeclarations.filter((d) => d.unused && !d.isExported);
    const unusedCSS = analysis.unusedCSSSelectors;

    if (unusedImps.length > 0 || unusedLocals.length > 0 || unusedCSS.length > 0) {
      fileHasIssues = true;
      console.log(`File: ${c.bold}${c.yellow}${fileRel}${c.reset}`);
      
      // Print Unused Imports
      if (unusedImps.length > 0) {
        console.log(`  Unused imports:`);
        for (const imp of unusedImps) {
          const names = imp.unusedBindings.map((b) => `${c.bold}${b.name}${c.reset}`).join(", ");
          console.log(`    - In ${c.dim}${imp.moduleSpecifier}${c.reset}: remove { ${names} }`);
        }
      }

      // Print Unused Locals
      if (unusedLocals.length > 0) {
        console.log(`  Unused local variables:`);
        const names = unusedLocals.map((d) => `${c.bold}${d.name}${c.reset} (${c.dim}${d.kind}${c.reset})`).join(", ");
        console.log(`    - { ${names} }`);
      }

      // Print Unused CSS
      if (unusedCSS.length > 0) {
        console.log(`  Unused CSS in Svelte:`);
        const selectors = unusedCSS.map((s) => `${c.bold}${s}${c.reset}`).join(", ");
        console.log(`    - Obsolete selectors: { ${selectors} }`);
      }
      console.log();
    }
  }

  // Print Dead Exports
  if (deadExports.length > 0) {
    console.log(`DEAD EXPORTS (EXPORTED BUT NEVER IMPORTED BY OTHER FILES):`);
    const groups = new Map<string, string[]>();
    for (const item of deadExports) {
      const list = groups.get(item.filePath) || [];
      list.push(item.deadExportName);
      groups.set(item.filePath, list);
    }

    for (const [file, names] of groups.entries()) {
      console.log(`  File: ${c.bold}${relative(rootFolder, file)}${c.reset}`);
      console.log(`    - Unused external exports: ${names.map((n) => `${c.bold}${n}${c.reset}`).join(", ")}`);
    }
    console.log();
  }

  // Print Dead Files
  if (deadFiles.length > 0) {
    console.log(`ORPHAN FILES DETECTED (NEVER IMPORTED IN THE PROJECT):`);
    for (const file of deadFiles) {
      let sizeText = "";
      try {
        const bytes = statSync(file).size;
        sizeText = `(${c.dim}${formatBytes(bytes)}${c.reset})`;
      } catch (e) {}
      console.log(`  - ${c.bold}${relative(rootFolder, file)}${c.reset} ${sizeText}`);
    }
    console.log();
  }

  // --- Step 4: Clean Phase (Interactive) ---
  const hasAnythingToClean = totalUnusedImports > 0 || totalUnusedVars > 0 || totalUnusedCSS > 0 || deadFiles.length > 0;

  if (!hasAnythingToClean) {
    console.log(`${c.green}No dead TypeScript, Svelte, or CSS code detected in this path.${c.reset}\n`);
    process.exit(0);
  }

  let performClean = !dryRun;

  // Interactive Prompt if running in dry-run mode
  if (dryRun) {
    console.log(`${c.yellow}This analysis was performed in report-only mode (Dry Run). No files were modified.${c.reset}`);
    const answer = readlinePrompt(`Do you want to apply automatic cleaning to these files now? (${c.bold}y/n${c.reset}): `);
    if (answer?.toLowerCase() === "y" || answer?.toLowerCase() === "yes" || answer?.toLowerCase() === "s" || answer?.toLowerCase() === "si") {
      performClean = true;
    }
  }

  if (performClean) {
    console.log(`\n${c.bold}${c.green}Starting automatic cleaning process...${c.reset}`);
    
    // 1. Create backups if enabled
    if (backupEnabled) {
      console.log(`${c.blue}Creating backups in .supercleaner-backup/...${c.reset}`);
      let backupCount = 0;
      for (const analysis of analyses) {
        const unusedImps = analysis.imports.filter((i) => i.unusedBindings.length > 0);
        const unusedLocals = analysis.localDeclarations.filter((d) => d.unused && !d.isExported);
        const unusedCSS = analysis.unusedCSSSelectors;

        if (unusedImps.length > 0 || unusedLocals.length > 0 || unusedCSS.length > 0) {
          createBackup(analysis.filePath, rootFolder);
          backupCount++;
        }
      }
      if (backupCount > 0) {
        console.log(`${c.green}Backups completed for ${backupCount} files.${c.reset}`);
      }
    }

    // 2. Apply cleaning on files
    let cleanedFilesCount = 0;
    for (const analysis of analyses) {
      const unusedImps = analysis.imports.filter((i) => i.unusedBindings.length > 0);
      const unusedLocals = analysis.localDeclarations.filter((d) => d.unused && !d.isExported);
      const unusedCSS = analysis.unusedCSSSelectors;

      if (unusedImps.length > 0 || unusedLocals.length > 0 || unusedCSS.length > 0) {
        try {
          const content = readFileSync(analysis.filePath, "utf-8");
          applyFileCleaning(analysis.filePath, content, analysis, cleanTypes);
          cleanedFilesCount++;
          console.log(`  Cleaned: ${c.bold}${relative(rootFolder, analysis.filePath)}${c.reset}`);
        } catch (e) {
          console.log(`  Error cleaning ${basename(analysis.filePath)}: ${e}`);
        }
      }
    }

    // 3. Handle dead files deletion/archive (interactive confirmation)
    if (deadFiles.length > 0 && !isSingleFile) {
      console.log(`\n${c.yellow}Found ${deadFiles.length} orphan files.${c.reset}`);
      const fileAction = readlinePrompt(`Do you want to physically delete these orphan files from disk? (${c.bold}y/n${c.reset}): `);
      if (fileAction?.toLowerCase() === "y" || fileAction?.toLowerCase() === "yes" || fileAction?.toLowerCase() === "s" || fileAction?.toLowerCase() === "si") {
        for (const file of deadFiles) {
          try {
            if (backupEnabled) {
              createBackup(file, rootFolder);
            }
            unlinkSync(file);
            console.log(`  Deleted: ${c.bold}${relative(rootFolder, file)}${c.reset}`);
          } catch (e) {
            console.log(`  Error deleting ${basename(file)}: ${e}`);
          }
        }
        console.log(`${c.green}Orphan files deletion completed.${c.reset}`);
      } else {
        console.log(`${c.yellow}Orphan files were kept intact.${c.reset}`);
      }
    }

    console.log(`\n${c.bold}${c.green}Cleaning completed successfully. Cleaned ${cleanedFilesCount} files.${c.reset}`);
    if (backupEnabled) {
      console.log(`${c.dim}Note: You can restore your files from the .supercleaner-backup/ folder if needed.${c.reset}\n`);
    }
  } else {
    console.log(`\n${c.yellow}Operation cancelled. No files were modified.${c.reset}\n`);
  }
}

main().catch((err) => {
  console.error(`${c.red}Critical error during SuperCleaner execution:${c.reset}`, err);
});

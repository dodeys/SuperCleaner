# SuperCleaner

A powerful, experimental Bun-native utility designed to scan, report, and automatically clean dead code (TypeScript, Svelte, and obsolete CSS) inside Dodeys workspace folders.

Since a significant portion of project code is AI-generated, it tends to leave behind unused local declarations, orphan imports, and obsolete stylesheet selectors. `supercleaner` helps maintain a clean, optimal codebase before deployments.

## Core Features

1. **Orphan Files (Dead Files)**: Detects `.ts`, `.js`, and `.svelte` files with zero incoming imports from other files. Automatically excludes SvelteKit routing conventions (`+page.svelte`, `+server.ts`, etc.), test suites, and core configuration assets.
2. **Dead Exports**: Identifies functions, constants, or classes with `export` modifiers that are never imported anywhere else in the project.
3. **Orphan Imports (Unused Imports)**: Scans and safely removes unused imports in `.ts` and `.svelte` scripts.
4. **Unused Local Declarations**: Detects unused local variables, functions, types, interfaces, or enums declared inside a file.
5. **Unused Svelte CSS (Obsolete Selectors)**: Analyzes `<style>` tags in Svelte components, identifying and removing classes or IDs that are not referenced in the HTML template.

---

## Operating Modes and Safety Measures

* **Dry Run (Default)**: Scans the target workspace and prints a detailed report in the console without modifying any files.
* **Automatic Backup**: When executing active cleaning (`--clean`), SuperCleaner creates an exact copy of modified files inside `.supercleaner-backup/` before rewriting them. This allows an immediate rollback if needed.
* **Interactive Prompts**: Solicits confirmation at each cleaning stage.

---

## Getting Started

First, navigate to the utility folder and install the development dependencies (primarily the native TypeScript compiler API used for AST analysis):

```bash
cd experimental/supercleaner
/Users/imac/.bun/bin/bun install
```

### Usage Examples

#### 1. Scan a Specific Worker (Report / Dry Run Mode)
```bash
/Users/imac/.bun/bin/bun run index.ts --path ../../dodeys-api-worker
```

#### 2. Scan and Clean Specific Categories (Imports and CSS Selectors)
```bash
/Users/imac/.bun/bin/bun run index.ts --path ../../dodeys-dash-worker --clean --type imports,css
```

#### 3. Scan the Entire Dodeys Project Directory
```bash
/Users/imac/.bun/bin/bun run index.ts --path ../../
```

---

## CLI Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--path` | `string` | The directory or file to analyze (defaults to current working directory). |
| `--clean` | `boolean` | Executes real, on-disk file cleaning. If omitted, runs in report-only (dry run) mode. |
| `--type` | `string` | Comma-separated list of clean targets: `imports`, `variables`, `css`, `files`, or `all` (default). |
| `--no-backup` | `boolean` | Disables automated file backups. Backups are enabled by default. |

---

## Svelte Framework Guardrails

* **Template-Aware Refcounting**: A component imported in Svelte scripts (e.g., `import Button from "./Button.svelte"`) that is only referenced in Svelte's HTML template (`<Button />`) will **not** be flagged as unused. SuperCleaner scans the entire file content before marking any import as orphan.
* **Route Ignorance**: SvelteKit routes prefixed with `+` are considered public API entrypoints and are strictly protected from dead file classification.

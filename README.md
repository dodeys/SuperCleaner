# SuperCleaner

Experimental Bun utility to scan, report, and optionally remove dead code in TypeScript, JavaScript, and Svelte projects.

It targets common leftovers from generated code: unused imports, unused locals, obsolete Svelte CSS selectors, unreachable modules, and exported symbols that nothing imports.

## Features

1. **Orphan files** — modules with no incoming imports inside the scanned tree.
2. **Dead exports** — named exports never imported from another file (resolved by module path, not text search).
3. **Unused imports** — removes unused named/default bindings from import statements.
4. **Unused locals** — flags unused non-exported declarations (with conservative safety rules).
5. **Unused Svelte CSS** — selectors in `<style>` blocks not referenced by the component template.

## Safety model

- **Dry run by default** — reports only unless `--clean` is passed.
- **Backups** — writes copies to `.supercleaner-backup/` before edits (disable with `--no-backup`).
- **Protected files** — SvelteKit routes (`+page.svelte`, etc.), `app.d.ts`, hooks, declaration files, and shared `lib/` modules are not treated as orphan files.
- **Entry points** — worker/app entry files and test files are excluded from orphan/dead-export heuristics.
- **Path aliases** — resolves `$lib`, `@/`, `~/`, `src/`, and `tsconfig` paths from the detected project root.
- **Cross-folder context** — when scanning `src/`, test files and the full `src` tree are included for import/export analysis.

## Install

```bash
cd experimental/supercleaner
bun install
```

## Usage

```bash
# Report only (recommended first)
bun run index.ts --path /path/to/your-project

# Scan a subdirectory (project root is auto-detected upward)
bun run index.ts --path /path/to/your-project/src

# Apply safe cleanups (imports, variables, css)
bun run index.ts --path /path/to/your-project --clean --type imports,variables,css

# Non-interactive clean (skips prompts; never auto-deletes orphan files)
bun run index.ts --path /path/to/your-project --clean --yes
```

## CLI flags

| Flag | Description |
|------|-------------|
| `--path <dir\|file>` | Target to analyze (default: current directory). |
| `--clean` | Apply changes on disk. |
| `--type <list>` | `imports`, `variables`, `css`, `files`, or `all` (default). |
| `--no-backup` | Skip `.supercleaner-backup/` copies. |
| `--yes` / `-y` | Auto-confirm clean prompt; orphan file deletion stays off unless you confirm manually. |

## Framework notes

- **Svelte**: imports used only in templates are kept. Tag selectors without classes/IDs are not removed automatically.
- **SvelteKit**: `+` route files are always treated as entrypoints.
- **Tests**: files under `test/`, `tests/`, and `__tests__/` are included when resolving dead exports, even if you only scan `src/`.

## Limitations

- Dynamic imports with non-literal specifiers are not tracked.
- Framework virtual modules (`$app/*`, etc.) are ignored for file resolution.
- Orphan file deletion is opt-in and always requires explicit confirmation (unless you answer the prompt).

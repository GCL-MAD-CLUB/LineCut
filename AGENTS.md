# AGENTS.md

## Repository organization

- Keep Rust tests inline in the implementation file under `#[cfg(test)] mod tests`.
  Do not create standalone Rust test files, external test modules, or Rust test directories.
- Keep deterministic frontend tests in `tests/unit/`, manual browser tests in
  `tests/browser/`, and external-tool tests in `tests/integration/`.
- `scripts/` contains executable build, asset preparation, release, and repository
  check commands only. Every script needs a `package.json` entry point. Do not put
  tests, experiments, or documentation inventories there.
- Keep documentation focused on maintained contracts and user instructions.
  Delete obsolete notes instead of accumulating progress logs, incident reports,
  one-off benchmarks, unfinished plans, and duplicate feature inventories.
- Run `npm run check:layout` and `npm test` after changing repository tooling or
  moving tests. Keep real media encoding and model/GPU checks out of normal CI.

## Code formatting

- TypeScript, TSX, JavaScript, JSON, CSS, HTML, and Markdown are formatted with the
  project-local Prettier configuration in `.prettierrc.json`.
- Rust is formatted with `cargo fmt` using `src-tauri/Cargo.toml`.
- Format changed frontend files with `npx prettier --write <files>`.
- Format Rust changes with `npm run format:rust`.
- Use `npm run format` only when formatting the whole repository is intentional.
- `npm run format:check` checks the whole repository; report pre-existing failures instead of
  reformatting unrelated files.
- Do not manually reformat unrelated files or overwrite unrelated working-tree changes.
- VS Code is configured in `.vscode/settings.json` to format supported files on save.
- Conduct reviews primarily at the code level; generating videos and then using software to perform complex tests is prohibited.
- If you need to preview the frontend, please shut down your preview process yourself after the task is finished. Do not leave port 1420 occupied when you are done.

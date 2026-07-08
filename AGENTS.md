# AGENTS.md

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

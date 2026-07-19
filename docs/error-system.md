# Error system

LineCut has one typed error pipeline. Classification is declared where an error is created; no
layer is allowed to infer a category from an error message.

The application implementation intentionally stays compact:

- `model.ts`: closed categories, public types, and the client error catalog;
- `runtime.ts`: native command boundary, normalization, policies, incident state, and operations;
- `ErrorUI.tsx`: the React error boundary and shared modal outlet;
- `index.ts`: an explicit public facade that exposes no internal storage or classification API.

## Native source contract

Every recoverable native failure is an `AppError` created with:

```rust
app_error(
    ErrorCode::ProjectReadFailed,
    format!("Failed to read project file {}: {error}", path.display()),
)
```

`ErrorCode` is an enum generated from the single catalog in `src-tauri/src/error.rs`. Every entry
declares all public metadata at compile time:

```text
Rust variant -> stable public code -> category -> retryable
```

The private `detail` is authored in English and contains the diagnostic context needed by logs.
`AppError::new` assigns an error ID and records the ID, code, category, and detail immediately.
There is deliberately no `From<String>`, text classifier, generic string fallback, or implicit
conversion into `AppError`.

Internal functions return `AppResult<T>`. Tauri commands return `CommandResult<T>`. At the Tauri
boundary, `AppError` uses an explicit public serialization allow-list:

```json
{
  "errorId": "ERR-...",
  "code": "PROJECT_READ_FAILED",
  "category": "io",
  "retryable": true
}
```

The native diagnostic detail is never serialized. A regression test verifies that secrets in a
detail cannot cross this boundary.

Two deliberately infallible commands are kept in an explicit repository-gate allow-list:
`path_is_file` performs a boolean existence probe, and `record_frontend_incident` is the terminal
best-effort logging sink. Every other Tauri command must positively declare `CommandResult<T>`.

## Application contract

`invokeCommand` is the only application command boundary. It accepts the native `category` only
when it belongs to the shared closed category set. A malformed or non-structured boundary failure
becomes the explicitly classified application fallback `UNEXPECTED_ERROR/runtime`; it is never
classified by inspecting text.

Application-originated failures select a typed catalog entry from `src/errors/model.ts` with
`clientError(stableCode, englishDiagnostic)`. The catalog declares category and retryability for
every client code, mirroring Rust's `ErrorCode` design. Raw `Error`, `DOMException`, and
unclassified `throw` sites are forbidden by the repository gate.

`src/errors/runtime.ts` owns command normalization, operation policies, incident state, and global
handlers. `runOperation`, task progress, and the React error boundary all send their
normalized error to `IncidentCenter`. The center records the private frontend diagnostic in the
native log, suppresses cancellation and configured background fallbacks, and sends every visible
error to the shared modal outlet. Repeated incidents with the same operation and code are aggregated
inside a 30-second logging window; the aggregate records its occurrence count and last-seen time.

## User presentation

The UI never chooses content from the error code or diagnostic. It uses only the category to read
the exhaustive internal `categoryMessages` table:

| Category       | Meaning of the public template                         |
| -------------- | ------------------------------------------------------ |
| `cancelled`    | The operation was cancelled; normally not displayed    |
| `validation`   | Input or settings are invalid                          |
| `resource`     | A required file or resource is unavailable             |
| `state`        | Current application state cannot perform the operation |
| `io`           | A file read or write failed                            |
| `format`       | File content or format cannot be recognized            |
| `security`     | File security information cannot be verified           |
| `externalTool` | A media-processing component failed                    |
| `media`        | Media content could not be processed                   |
| `platform`     | The operating system could not perform the operation   |
| `runtime`      | The application encountered a runtime failure          |
| `unsupported`  | The content or operation is not supported              |

Operation policy controls only whether an error is silent and the modal title. Safe public context
may add a basename such as `clip.mp4` to the title, so an import failure can still identify the
media. Full paths, native details, external-tool stderr, keys, and parsed source messages are never
used in the modal body. The modal may show the opaque error ID so support can correlate it with the
private log.

Successful operations may return `UserNotice` values. They are a separate public channel for safe,
non-fatal information and warnings. `UserNotice` contains only `code`, `severity`, and an already
sanitized user message. A private warning detail can be logged through `warning_with_detail`, but
it is not serialized with the notice. Filenames are allowed where useful; private diagnostics and
full paths are not.

## Enforcement

`npm run check:errors` uses the TypeScript syntax tree for frontend imports and calls, and rejects:

- direct frontend Tauri invocation outside the command boundary;
- awaiting or aggregating the fire-and-forget `runBackgroundOperation` helper;
- legacy `publishError`/`reportError`, console diagnostics, and string warning arrays;
- raw frontend `Error`/`DOMException`, unclassified throws, or invalid `clientError` categories;
- client diagnostics authored with CJK text;
- raw Rust `Result<_, String>`, string `Err(...)`, and string-to-`AppError` conversions;
- `classify_error` or any equivalent text-classification entry point;
- `app_error` calls without a literal `ErrorCode` or with diagnostics authored in CJK text;
- direct `AppError::new` outside the error module;
- Tauri commands that bypass `CommandResult`.

TypeScript additionally requires complete operation policy and category-template coverage. Rust's
`ErrorCode::definition` match requires every native code to declare category and retryability.

## Adding a failure

1. Add a stable `ErrorCode` catalog entry with category and retryability.
2. Construct it at the exact native failure site with a precise English diagnostic, then propagate
   `AppResult`; never wrap it again by message.
3. For an application-originated failure, create it with `clientError` at its source.
4. Add an operation key/policy only when the workflow itself is new. Do not add error-specific user
   text; reuse the category template.
5. Pass only safe public context such as a basename.
6. Run `npm run check:errors`, `npm run build`, Rust tests, and formatting checks.

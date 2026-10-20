# Error handling contracts

This maintainer reference describes the Locution Pro 0.4.0 baseline. User recovery steps belong in the user guide; diagnostic formats and implementation details belong here.

## Classify at the source

Every recoverable native failure is an `AppError` with a literal `ErrorCode` from `src-tauri/src/error.rs`. The catalog defines a stable public code, category and retryability. Internal functions return `AppResult<T>`; Tauri commands return `CommandResult<T>`.

Diagnostic detail is written in English and logged with the assigned error ID. Do not infer categories from text, wrap errors as strings or introduce implicit string conversion.

Only allow-listed public fields cross the native boundary: `errorId`, `code`, `category` and `retryable`. Native detail, full paths, tool stderr and secret material must not be serialized as public errors.

## Normalize at one boundary

`invokeCommand` is the application command boundary. It accepts categories only from the shared closed set. Malformed failures become the explicitly classified `UNEXPECTED_ERROR/runtime` fallback, without inspecting diagnostic text.

Application failures use `clientError` with a typed entry in `src/errors/model.ts`. The application catalog also declares category and retryability. Do not throw raw `Error`, `DOMException` or unclassified values.

`src/errors/runtime.ts` owns normalization, operation policy, incident state and global handling. `ErrorUI.tsx` provides the React boundary and shared modal outlet; the facade must not expose internal storage.

## Present safe recovery information

The visible body comes from the exhaustive category template, rather than the native code or diagnostic text.

| Category     | Recovery topic                             |
| ------------ | ------------------------------------------ |
| cancelled    | Normal cancellation, normally silent       |
| validation   | Invalid input or settings                  |
| resource     | Missing required resource                  |
| state        | Operation unavailable in the current state |
| io           | File read or write failure                 |
| format       | Unrecognized content                       |
| security     | Failed security verification               |
| externalTool | Media component failure                    |
| media        | Media processing failure                   |
| platform     | Operating system failure                   |
| runtime      | Unexpected application failure             |
| unsupported  | Unsupported operation or content           |

Operation policy selects silence and title. Safe context may include a basename; an opaque error ID links the report to private logs. Full diagnostics must never become modal text.

Successful operations may return sanitized `UserNotice` values with code, severity and public message. Private warning details are logged separately.

## Aggregate and isolate incidents

Operations, task progress and the React boundary route normalized failures through `IncidentCenter`. Repeated operation/code pairs aggregate within the logging window, retaining count and last occurrence.

Cancellation is an expected outcome. `TASK_NOT_RUNNING` during cancellation of completed native work is handled at that boundary. Detection or extraction failure must not fail unrelated queued media.

Panel persistence failures use their own load/save operation policies and must not be reported as successful project saves. Background cache maintenance can log a failure while retaining usable records; it must not turn a successful append into an unrelated warning.

## Enforce the contract

`npm run check:errors` checks command boundaries, typed creation sites, English diagnostics and forbidden raw errors. The explicit infallible command allow-list covers `path_is_file` and the terminal `record_frontend_incident` sink.

For a new failure:

1. Add a typed catalog code with category and retryability.
2. Construct the error at its source with useful private context.
3. Propagate without reclassification.
4. Add an operation policy only for a new workflow.
5. Keep visible recovery text in category templates and user instructions in the guide.
6. Run the error gate, applicable tests and build checks.

See [system contracts](system-architecture.md), [media processing](media-processing.md) and [contribution guidance](../CONTRIBUTING.md).

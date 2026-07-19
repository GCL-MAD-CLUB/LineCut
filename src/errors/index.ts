// Public application facade. Internal classification, storage, and logging APIs stay private.
export { AppErrorBoundary, ErrorOutlet } from "./ErrorUI";
export { clientError } from "./model";
export type { ClientErrorCode, OperationKey, OperationOutcome, PublicContext } from "./model";
export {
  captureOperationError,
  installGlobalErrorHandlers,
  invokeCommand,
  runBackgroundOperation,
  runOperation,
} from "./runtime";

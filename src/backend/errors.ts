// Error type with a stable `code` that crosses the IPC/HTTP boundary (see BackendError in shared/api.ts).
export class BackendFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

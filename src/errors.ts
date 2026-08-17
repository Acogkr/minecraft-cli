export class MinecraftCliError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "MinecraftCliError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof MinecraftCliError) {
    return {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false as const,
    error: {
      code: "INTERNAL_ERROR",
      message
    }
  };
}

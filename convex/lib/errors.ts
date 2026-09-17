import { ConvexError } from 'convex/values';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_ENTITLED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SESSION_NOT_PAID'
  | 'DOWNLOAD_WINDOW_CLOSED'
  | 'NOT_CONFIGURED';

// Production redacts plain Error messages; ConvexError data reaches the client.
export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

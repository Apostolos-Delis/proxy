export class AdminMutationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues?: { path: string; message: string }[]
  ) {
    super(message);
  }
}

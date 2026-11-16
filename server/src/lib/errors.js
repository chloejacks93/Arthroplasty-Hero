export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

/** Parse with a zod schema, raising a friendly 400 on failure. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `${first.field || 'input'}: ${first.message}` : 'Invalid input.', issues);
  }
  return r.data;
}

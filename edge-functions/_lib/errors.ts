export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, message: string, code = "BAD_REQUEST") {
    super(message)
    this.status = status
    this.code = code
  }
}

export function assert(condition: unknown, message: string, status = 400, code = "BAD_REQUEST"): asserts condition {
  if (!condition) throw new ApiError(status, message, code)
}

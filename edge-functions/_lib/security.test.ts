import { describe, expect, it } from "vitest"
import { requireAdmin } from "./security"

const request = (secret?: string) => new Request("https://example.com/api/admin/rooms", {
  headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
})

describe("requireAdmin", () => {
  it("accepts the configured secret", async () => {
    await expect(requireAdmin(request("a-strong-admin-secret"), {
      GAME_ADMIN_SECRET: "a-strong-admin-secret",
    })).resolves.toBeUndefined()
  })

  it("rejects a wrong secret without exposing the configured value", async () => {
    const result = requireAdmin(request("wrong-secret-value"), {
      GAME_ADMIN_SECRET: "a-strong-admin-secret",
    })
    await expect(result).rejects.toMatchObject({
      status: 401,
      code: "ADMIN_UNAUTHORIZED",
    })
  })

  it("fails closed when the environment variable is missing or weak", async () => {
    await expect(requireAdmin(request("anything-long-enough"), {})).rejects.toMatchObject({
      status: 503,
      code: "ADMIN_NOT_CONFIGURED",
    })
    await expect(requireAdmin(request("anything-long-enough"), {
      GAME_ADMIN_SECRET: "too-short",
    })).rejects.toMatchObject({
      status: 503,
      code: "ADMIN_NOT_CONFIGURED",
    })
  })
})

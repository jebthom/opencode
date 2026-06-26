import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ARCHITECTURE_ID, BUILTIN_LENSES } from "@/aperture/lenses"

// A3: Lens definitions + the active pointer persist in the project directory
// under .opencode/aperture/ (not global KV), so a Lens is shareable/committable.

const CREATE = {
  name: "Auth Flow",
  description: "Where auth happens",
  palette: "pastel" as const,
  prompt: "Tag files by their role in authentication.",
  facets: [
    { label: "Login", description: "login + session start" },
    { label: "Tokens", description: "token mint/verify" },
  ],
}

describe("aperture lens-store (project-dir persistence)", () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-lens-store-"))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("create writes lenses.json under .opencode/aperture and is additive", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, CREATE))
    expect(lens.facets.map((f) => f.id)).toEqual(["login", "tokens"])

    // The committable artifact landed on disk in the project directory.
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"))
    expect(onDisk[lens.id].name).toBe("Auth Flow")

    // list() returns built-ins first, then the new user Lens.
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.slice(0, BUILTIN_LENSES.length)).toEqual([...BUILTIN_LENSES])
    expect(all.some((l) => l.id === lens.id)).toBe(true)
  })

  test("active pointer round-trips through active.json", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Routing" }))
    // Defaults to architecture before any pointer is written.
    const pointerFile = path.join(dir, ".opencode", "aperture", "active.json")

    await Effect.runPromise(ApertureLensStore.setActive(dir, lens.id))
    expect(JSON.parse(await fs.readFile(pointerFile, "utf8"))).toEqual({ id: lens.id })

    const active = await Effect.runPromise(ApertureLensStore.getActive(dir))
    expect(active.id).toBe(lens.id)
  })

  test("getActive falls back to architecture when nothing is set", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-empty-"))
    try {
      const active = await Effect.runPromise(ApertureLensStore.getActive(empty))
      expect(active.id).toBe(ARCHITECTURE_ID)
      const list = await Effect.runPromise(ApertureLensStore.list(empty))
      expect(list).toEqual([...BUILTIN_LENSES])
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  test("remove drops a user Lens from disk", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Temp" }))
    expect(await Effect.runPromise(ApertureLensStore.remove(dir, lens.id))).toBe(true)
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.some((l) => l.id === lens.id)).toBe(false)
    // Removing a built-in (lives in code, not on disk) is a no-op.
    expect(await Effect.runPromise(ApertureLensStore.remove(dir, ARCHITECTURE_ID))).toBe(false)
  })
})

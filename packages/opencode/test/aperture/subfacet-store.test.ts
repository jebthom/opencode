import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { ApertureSubfacetStore } from "@/aperture/subfacet-store"

// In-memory Storage stub: read fails on a missing key (so the store's catch→{}
// and update→write fallbacks are exercised), update is read-modify-write.
function memStorage() {
  const m = new Map<string, unknown>()
  const k = (key: string[]) => key.join("/")
  const iface = {
    read: <T>(key: string[]) =>
      m.has(k(key)) ? Effect.succeed(m.get(k(key)) as T) : Effect.fail(new Error("missing")),
    update: <T>(key: string[], fn: (draft: T) => void) =>
      Effect.sync(() => {
        const cur = (m.get(k(key)) as T) ?? ({} as T)
        fn(cur)
        m.set(k(key), cur)
        return cur
      }),
    write: <T>(key: string[], content: T) => Effect.sync(() => void m.set(k(key), content)),
    remove: (key: string[]) => Effect.sync(() => void m.delete(k(key))),
    list: () => Effect.succeed([] as string[][]),
  } as unknown as Storage.Interface
  return { iface, m }
}

const PID = "proj"
const LENS = "auth-x"
const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

describe("aperture subfacet-store (function-level facets)", () => {
  test("empty until painted", async () => {
    const { iface } = memStorage()
    expect(await run(ApertureSubfacetStore.read(iface, PID, LENS))).toEqual({})
  })

  test("upsert writes per-function entries and read returns them", async () => {
    const { iface } = memStorage()
    await run(
      ApertureSubfacetStore.upsert(iface, PID, LENS, {
        n_aaa: { facet: "login", hash: "h1" },
        n_bbb: { facet: "tokens", hash: "h2" },
      }),
    )
    const store = await run(ApertureSubfacetStore.read(iface, PID, LENS))
    expect(store).toEqual({ n_aaa: { facet: "login", hash: "h1" }, n_bbb: { facet: "tokens", hash: "h2" } })
  })

  test("re-upsert overwrites a changed function (new hash) and is additive for others", async () => {
    const { iface } = memStorage()
    await run(ApertureSubfacetStore.upsert(iface, PID, LENS, { n_aaa: { facet: "login", hash: "h1" } }))
    await run(ApertureSubfacetStore.upsert(iface, PID, LENS, { n_aaa: { facet: "tokens", hash: "h2" } }))
    await run(ApertureSubfacetStore.upsert(iface, PID, LENS, { n_ccc: { facet: "login", hash: "h3" } }))
    const store = await run(ApertureSubfacetStore.read(iface, PID, LENS))
    expect(store.n_aaa).toEqual({ facet: "tokens", hash: "h2" })
    expect(store.n_ccc).toEqual({ facet: "login", hash: "h3" })
  })

  test("a stored entry with a matching hash is what lets the painter stale-skip", async () => {
    const { iface } = memStorage()
    await run(ApertureSubfacetStore.upsert(iface, PID, LENS, { n_aaa: { facet: "login", hash: "h1" } }))
    const store = await run(ApertureSubfacetStore.read(iface, PID, LENS))
    // The painter's filter is `store[id]?.hash !== hash` — same hash means skip.
    expect(store.n_aaa?.hash === "h1").toBe(true)
    expect(store.n_aaa?.hash === "h-changed").toBe(false)
  })

  test("mergeFacet rewrites one facet to another, preserving hashes", async () => {
    const { iface } = memStorage()
    await run(
      ApertureSubfacetStore.upsert(iface, PID, LENS, {
        n_aaa: { facet: "login", hash: "h1" },
        n_bbb: { facet: "login", hash: "h2" },
        n_ccc: { facet: "tokens", hash: "h3" },
      }),
    )
    await run(ApertureSubfacetStore.mergeFacet(iface, PID, LENS, "login", "tokens"))
    const store = await run(ApertureSubfacetStore.read(iface, PID, LENS))
    expect(store).toEqual({
      n_aaa: { facet: "tokens", hash: "h1" },
      n_bbb: { facet: "tokens", hash: "h2" },
      n_ccc: { facet: "tokens", hash: "h3" },
    })
  })

  test("clear empties the store (forcing a from-scratch re-paint)", async () => {
    const { iface } = memStorage()
    await run(ApertureSubfacetStore.upsert(iface, PID, LENS, { n_aaa: { facet: "login", hash: "h1" } }))
    await run(ApertureSubfacetStore.clear(iface, PID, LENS))
    expect(await run(ApertureSubfacetStore.read(iface, PID, LENS))).toEqual({})
  })

  test("namespaced per Lens — one Lens's functions don't leak into another", async () => {
    const { iface } = memStorage()
    await run(ApertureSubfacetStore.upsert(iface, PID, "lens-a", { n_aaa: { facet: "x", hash: "h1" } }))
    expect(await run(ApertureSubfacetStore.read(iface, PID, "lens-b"))).toEqual({})
  })
})

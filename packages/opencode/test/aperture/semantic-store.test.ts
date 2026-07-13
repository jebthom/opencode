import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { ApertureSemanticStore } from "@/aperture/semantic-store"
import { NONE_FACET } from "@/aperture/lenses"

// In-memory Storage stub: read fails on a missing key (so the store's catch→{} and
// update→write fallbacks are exercised), update is read-modify-write.
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
  return iface
}

const PID = "proj"
const CHILD = "child-lens"
const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

// `via` — the parent facet each file was witnessed by — is what keeps a parent's facet merge
// free for its drill-downs (no re-paint) while still re-opening exactly the files the merge
// newly admitted. These cover the two store ops that fold a merge through a child.
describe("aperture semantic-store (drill-down witnesses)", () => {
  // A child scoped to "likely": in-domain files carry via=likely, out-of-domain files were
  // bucketed grey with via=unlikely.
  const seed = (storage: Storage.Interface) =>
    run(
      ApertureSemanticStore.upsert(storage, PID, CHILD, {
        cpu: { facet: "cpu", hash: "h1", via: "likely" },
        io: { facet: "io", hash: "h2", via: "likely" },
        misfit: { facet: NONE_FACET, hash: "h3", via: "likely" }, // in domain, fits no facet
        excluded: { facet: NONE_FACET, hash: "h4", via: "unlikely" }, // out of domain
      }),
    )

  test("mergeFacet preserves `via` while relabelling the facet", async () => {
    const storage = memStorage()
    await seed(storage)
    await run(ApertureSemanticStore.mergeFacet(storage, PID, CHILD, "io", "cpu"))
    const store = await run(ApertureSemanticStore.read(storage, PID, CHILD))
    expect(store.io).toEqual({ facet: "cpu", hash: "h2", via: "likely" })
  })

  test("remapVia moves witnesses onto the surviving facet, touching nothing else", async () => {
    const storage = memStorage()
    await seed(storage)
    await run(ApertureSemanticStore.remapVia(storage, PID, CHILD, "likely", "certain"))
    const store = await run(ApertureSemanticStore.read(storage, PID, CHILD))
    // Witness follows the fold; the file's own facet and content hash are untouched, so
    // nothing re-paints.
    expect(store.cpu).toEqual({ facet: "cpu", hash: "h1", via: "certain" })
    expect(store.misfit).toEqual({ facet: NONE_FACET, hash: "h3", via: "certain" })
    // A file witnessed by a different facet is left alone.
    expect(store.excluded!.via).toBe("unlikely")
  })

  test("dropWhereVia deletes exactly the newly-admitted files, so only they re-paint", async () => {
    const storage = memStorage()
    await seed(storage)
    // The parent folds "unlikely" into "likely", widening the child's domain: the files it
    // had bucketed out are now inside and must be re-decided.
    await run(ApertureSemanticStore.dropWhereVia(storage, PID, CHILD, "unlikely"))
    const store = await run(ApertureSemanticStore.read(storage, PID, CHILD))

    // Deleting the entry is what re-opens the file (the painter re-paints any node with no
    // entry). The genuinely-unclassifiable file keeps its grey — it cost tokens to produce
    // and its verdict hasn't changed.
    expect(store.excluded).toBeUndefined()
    expect(store.misfit).toEqual({ facet: NONE_FACET, hash: "h3", via: "likely" })
    expect(store.cpu).toBeDefined()
  })

  test("drop-then-remap is order-dependent: remapping first would wipe correct paint", async () => {
    const storage = memStorage()
    await seed(storage)
    // The real sequence aperture.mergeFacets runs when folding "unlikely" into "likely" for a
    // child scoped only to "likely": drop the newly-admitted files FIRST, then remap. If the
    // remap ran first, every file would read via="likely" and the drop would delete the
    // already-correct paint too.
    await run(ApertureSemanticStore.dropWhereVia(storage, PID, CHILD, "unlikely"))
    await run(ApertureSemanticStore.remapVia(storage, PID, CHILD, "unlikely", "likely"))
    const store = await run(ApertureSemanticStore.read(storage, PID, CHILD))

    expect(store.excluded).toBeUndefined() // re-opened
    expect(store.cpu).toEqual({ facet: "cpu", hash: "h1", via: "likely" }) // survived intact
    expect(store.io).toEqual({ facet: "io", hash: "h2", via: "likely" })
    expect(Object.keys(store).sort()).toEqual(["cpu", "io", "misfit"])
  })
})

import { describe, expect, test } from "bun:test"
import { isPlumbing } from "@/aperture/plumbing"

describe("isPlumbing", () => {
  test("Lens definitions, Lens history and session logs are plumbing", () => {
    expect(isPlumbing(".opencode/aperture/lenses.json")).toBe(true)
    expect(isPlumbing(".opencode/aperture/active.json")).toBe(true)
    expect(isPlumbing(".opencode/aperture/lens-history.jsonl")).toBe(true)
    expect(isPlumbing("perf/logs/sessions/2026-10-06_10-00-00_ses_1/events.jsonl")).toBe(true)
    expect(isPlumbing("perf/autosession.log")).toBe(true)
    expect(isPlumbing("perf/painter.log")).toBe(true)
  })

  test("the user's own files, including other .opencode config, are not", () => {
    expect(isPlumbing(".opencode/opencode.jsonc")).toBe(false)
    expect(isPlumbing(".opencode/aperture-notes.md")).toBe(false)
    expect(isPlumbing("perf/logs/other.log")).toBe(false)
    expect(isPlumbing("perf/benchmark.log")).toBe(false)
    expect(isPlumbing("src/aperture/lenses.ts")).toBe(false)
  })
})

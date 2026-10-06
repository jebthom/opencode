// Test file to verify Aperture lens marking patterns

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RULE-EVALUATION: matches /^(export\s+)?(const\s+evaluate|function\s+evaluate)/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const evaluate = (rule: unknown): string => {
  return "evaluated"
}

function evaluate(input: string): void {
  console.log(input)
}

export function evaluate(test: boolean): boolean {
  return test
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FINDER-VALIDATION: matches /(isValidFinder|finderProblem|whereProblem)/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isValidFinder(obj: unknown): boolean {
  return typeof obj === 'object'
}

const finderProblem = new Error('Finder validation failed')

function whereProblem(msg: string): Error {
  return new Error(`Where clause problem: ${msg}`)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LENS-PERSISTENCE: matches /(readProject|writeProject|export\s+const\s+(list|get|mark|unmark|update|remove))/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function readProject(path: string) {
  return { name: 'test' }
}

function writeProject(data: any) {
  return true
}

export const list = () => []
export const get = (id: string) => null
export const mark = (lens: any) => true
export const unmark = (id: string) => true
export const update = (lens: any) => true
export const remove = (id: string) => true

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INCREMENTAL-MEMOIZATION: matches /(interface\s+RuleMemo|ruleMemo\[|ruleHitsFor|capOf|clampAll)/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface RuleMemo {
  hits: Map<string, number>
  timestamp: number
}

const ruleMemo: Map<string, RuleMemo> = new Map()
ruleMemo['rule1'] = { hits: new Map(), timestamp: Date.now() }

function ruleHitsFor(ruleId: string): number {
  return 0
}

function capOf(limit: number): number {
  return Math.max(0, limit)
}

function clampAll(values: number[]): number[] {
  return values.map(v => Math.max(0, Math.min(100, v)))
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CACHE-CLEARING: matches /onSessionIdle|filesCache\.delete|isRepoCache\.delete|ruleMemo\.delete/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onSessionIdle() {
  filesCache.delete('key1')
  isRepoCache.delete('repo1')
  ruleMemo.delete('rule1')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OWNERSHIP-CONSENT: matches /(consentNeeded|switchNeedsConsent|canMutate|owner\s*===)/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function consentNeeded(action: string): boolean {
  return action === 'mutate'
}

function switchNeedsConsent(from: string, to: string): boolean {
  return from !== to
}

function canMutate(userId: string, resourceId: string): boolean {
  return true
}

function checkOwner(current: string, expected: string): boolean {
  return current === expected
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GIT-INTEGRATION: matches /(export\s+function\s+make|const\s+changes|const\s+blame|GitLookup)/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function make(config: any) {
  return { lookup: () => null }
}

const changes = new Map()

const blame = new Map()

interface GitLookup {
  getBlame(file: string): Map<number, string>
  getChanges(ref: string): string[]
}

const filesCache = new Map()
const isRepoCache = new Map()

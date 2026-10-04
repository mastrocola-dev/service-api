import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApi, limits } from '../src/api.ts'
import { stores } from '../src/store.ts'
import { memoryTable } from './fixtures/memory.ts'

const noon = Date.UTC(2026, 9, 4, 12)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const question = { question: 'Why multi-repo?', token: 'turnstile-token' }

const setup = ({ human = true } = {}) => {
  const table = memoryTable()
  const sent: object[] = []
  const verified: [string, string][] = []
  const clock = { now: noon, ids: 0 }
  const api = createApi({
    ...stores(table),
    verify: async (token, ip) => {
      verified.push([token, ip])
      return human
    },
    send: async (message) => {
      sent.push(message)
    },
    now: () => clock.now,
    uuid: () => uuid(++clock.ids),
  })
  return { api, table, sent, verified, clock }
}

const accepted = async ({ api }: ReturnType<typeof setup>, ip = '203.0.113.7') => ((await api.submit(question, ip)).body as { jobId: string }).jobId
const event = (jobId: string, seq: number, rest: object) => ({ v: 1, jobId, seq, ...rest })
const done = { type: 'completed', costUsd: 0.007, output: { outOfScope: false, answer: 'One repository per concern.', sources: ['adr/001-multi-repo.md'] } }

test('accepts a question, stores the job and queues it for the worker', async () => {
  const context = setup()
  const reply = await context.api.submit({ ...question, question: '  Why multi-repo?  ' }, '203.0.113.7')
  assert.deepEqual(reply, { status: 202, body: { jobId: `20261004-${uuid(1)}` } })
  assert.deepEqual(context.sent, [{ v: 1, type: 'run', jobId: `20261004-${uuid(1)}`, instance: 'ask', input: { question: 'Why multi-repo?' } }])
  assert.deepEqual(context.verified, [['turnstile-token', '203.0.113.7']])
  assert.deepEqual(await context.api.status(`20261004-${uuid(1)}`), { status: 200, body: { status: 'queued' } })
})

for (const [name, body, ip] of [
  ['a short question', { ...question, question: 'hi' }, '203.0.113.7'],
  ['a question over 500 characters', { ...question, question: 'x'.repeat(501) }, '203.0.113.7'],
  ['a missing challenge token', { question: question.question }, '203.0.113.7'],
  ['a body that is not an object', 'question', '203.0.113.7'],
  ['a request without a client address', question, undefined],
] as const) {
  test(`refuses ${name} before any check that costs something`, async () => {
    const context = setup()
    assert.deepEqual(await context.api.submit(body, ip), { status: 400, body: { error: 'invalid' } })
    assert.deepEqual([context.verified.length, context.sent.length, context.table.rows.size], [0, 0, 0])
  })
}

test('refuses a failed challenge without consuming the quota', async () => {
  const context = setup({ human: false })
  assert.deepEqual(await context.api.submit(question, '203.0.113.7'), { status: 403, body: { error: 'challenge' } })
  assert.equal(context.table.rows.size, 0)
})

test('never stores the client address', async () => {
  const context = setup()
  await accepted(context)
  assert.doesNotMatch(JSON.stringify([...context.table.rows]), /203\.0\.113\.7/)
})

test('limits each address to ten questions a day, counted per address', async () => {
  const context = setup()
  for (let asked = 0; asked < limits.questionsPerDay; asked++) {
    const jobId = await accepted(context)
    await context.api.apply(event(jobId, 0, done))
  }
  assert.deepEqual(await context.api.submit(question, '203.0.113.7'), { status: 429, body: { error: 'quota' } })
  assert.equal((await context.api.submit(question, '198.51.100.9')).status, 202)
  context.clock.now += 86_400_000
  assert.equal((await context.api.submit(question, '203.0.113.7')).status, 202)
})

test('limits unfinished jobs and forgets those that never finished', async () => {
  const context = setup()
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await accepted(context, ip)
  assert.deepEqual(await context.api.submit(question, '198.51.100.4'), { status: 429, body: { error: 'busy' } })
  context.clock.now += limits.concurrencyWindowMs
  assert.equal((await context.api.submit(question, '198.51.100.4')).status, 202)
})

test('stops accepting questions when the daily budget is spent, before verifying the challenge', async () => {
  const context = setup()
  const jobId = await accepted(context)
  await context.api.apply(event(jobId, 0, { ...done, costUsd: limits.dailyBudgetUsd }))
  assert.deepEqual(await context.api.submit(question, '198.51.100.9'), { status: 503, body: { error: 'budget' } })
  assert.equal(context.verified.length, 1)
  context.clock.now += 86_400_000
  assert.equal((await context.api.submit(question, '198.51.100.9')).status, 202)
})

test('counts the cost of failed jobs in the budget', async () => {
  const context = setup()
  const jobId = await accepted(context)
  await context.api.apply(event(jobId, 1, { type: 'failed', reason: 'budget', costUsd: limits.dailyBudgetUsd }))
  assert.equal((await context.api.submit(question, '198.51.100.9')).status, 503)
})

test('follows a job through its events and reports only the latest step', async () => {
  const context = setup()
  const jobId = await accepted(context)
  await context.api.apply(event(jobId, 0, { type: 'started', addedLater: true }))
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'running' })
  await context.api.apply(event(jobId, 2, { type: 'step', kind: 'tool', name: 'docs__read_document' }))
  await context.api.apply(event(jobId, 1, { type: 'step', kind: 'model' }))
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'running', step: { kind: 'tool', name: 'docs__read_document' } })
  await context.api.apply(event(jobId, 3, done))
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'done', output: done.output })
})

test('keeps a finished job final', async () => {
  const context = setup()
  const jobId = await accepted(context)
  await context.api.apply(event(jobId, 1, { type: 'failed', reason: 'error', costUsd: 0.002 }))
  await context.api.apply(event(jobId, 2, done))
  await context.api.apply(event(jobId, 3, { type: 'step', kind: 'model' }))
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'failed', reason: 'error' })
})

for (const [name, message] of [
  ['an unknown type', { type: 'later' }],
  ['an unknown version', { ...done, v: 2 }],
  ['an answer over the limits', { ...done, output: { ...done.output, answer: 'x'.repeat(1501) } }],
  ['a negative sequence', { type: 'started', seq: -1 }],
] as const) {
  test(`ignores an event with ${name}`, async () => {
    const context = setup()
    const jobId = await accepted(context)
    await context.api.apply({ ...event(jobId, 0, {}), ...message })
    assert.deepEqual((await context.api.status(jobId)).body, { status: 'queued' })
  })
}

test('ignores events for a job it does not know', async () => {
  const context = setup()
  await context.api.apply(event(`20261004-${uuid(9)}`, 0, done))
  await context.api.apply(event('not-a-job', 0, done))
  assert.equal(context.table.rows.size, 0)
})

test('reports a job that never finished as failed, without rewriting it', async () => {
  const context = setup()
  const jobId = await accepted(context)
  context.clock.now += limits.staleAfterMs + 1
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'failed', reason: 'timeout' })
  await context.api.apply(event(jobId, 0, done))
  assert.deepEqual((await context.api.status(jobId)).body, { status: 'done', output: done.output })
})

test('answers 404 for unknown or malformed job ids', async () => {
  const { api } = setup()
  for (const id of [`20261004-${uuid(1)}`, 'job', '../secrets']) assert.deepEqual(await api.status(id), { status: 404, body: { error: 'unknown' } })
})

test('wakes the worker at most once a minute', async () => {
  const context = setup()
  assert.equal((await context.api.warm()).status, 202)
  assert.equal((await context.api.warm()).status, 202)
  assert.deepEqual(context.sent, [{ v: 1, type: 'warm' }])
  context.clock.now += limits.warmIntervalMs
  await context.api.warm()
  assert.equal(context.sent.length, 2)
})

test('purges everything older than the retention, keeping the warm-up state', async () => {
  const context = setup()
  const old = await accepted(context)
  await context.api.warm()
  context.clock.now += 2 * 86_400_000
  const recent = await accepted(context)
  await context.api.purge()
  assert.equal((await context.api.status(old)).status, 404)
  assert.equal((await context.api.status(recent)).status, 200)
  assert.deepEqual(
    [...context.table.rows.keys()].filter((key) => key.startsWith('2026-10-04')),
    [],
  )
  assert.ok(context.table.rows.has('state|warm'))
})

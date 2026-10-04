import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Job, JobStore, QuotaStore } from './store.ts'

export const limits = {
  dailyBudgetUsd: 1,
  questionsPerDay: 10,
  concurrentJobs: 3,
  concurrencyWindowMs: 120_000,
  staleAfterMs: 180_000,
  warmIntervalMs: 60_000,
  retentionDays: 1,
}

const Submission = z.object({ question: z.string().trim().min(3).max(500), token: z.string().min(1).max(2048) })

const JobId = z.string().regex(/^\d{8}-[0-9a-f-]{36}$/)

const Envelope = { v: z.literal(1), jobId: JobId, seq: z.int().nonnegative() }

const Event = z.discriminatedUnion('type', [
  z.object({ ...Envelope, type: z.literal('started') }),
  z.object({ ...Envelope, type: z.literal('step'), kind: z.enum(['model', 'tool']), name: z.string().max(100).optional() }),
  z.object({ ...Envelope, type: z.literal('completed'), costUsd: z.number().nonnegative(), output: z.object({ outOfScope: z.boolean(), answer: z.string().max(1500), sources: z.array(z.string()).max(5) }) }),
  z.object({ ...Envelope, type: z.literal('failed'), costUsd: z.number().nonnegative(), reason: z.enum(['timeout', 'budget', 'redelivered', 'error']) }),
])

export type Dependencies = {
  jobs: JobStore
  quotas: QuotaStore
  verify: (token: string, ip: string) => Promise<boolean>
  send: (message: object) => Promise<void>
  now?: () => number
  uuid?: () => string
}

export type Reply = { status: number; body: unknown }

const day = (time: number) => new Date(time).toISOString().slice(0, 10)

const finished = (job: Job) => job.status === 'done' || job.status === 'failed'

const refuse = (status: number, error: string): Reply => ({ status, body: { error } })

function applied(job: Job, event: z.infer<typeof Event>): Job | undefined {
  if (finished(job) || event.seq <= job.seq) return undefined
  const { step: _, ...progress } = { ...job, seq: event.seq }
  if (event.type === 'started') return { ...progress, status: 'running' }
  if (event.type === 'step') return { ...progress, status: 'running', step: { kind: event.kind, ...(event.name && { name: event.name }) } }
  if (event.type === 'completed') return { ...progress, status: 'done', costUsd: event.costUsd, output: event.output }
  return { ...progress, status: 'failed', costUsd: event.costUsd, reason: event.reason }
}

export function createApi({ jobs, quotas, verify, send, now = Date.now, uuid = randomUUID }: Dependencies) {
  return {
    async submit(body: unknown, ip: string | undefined): Promise<Reply> {
      const submission = Submission.safeParse(body)
      if (!submission.success || !ip) return refuse(400, 'invalid')
      const today = day(now())
      const todays = await jobs.ofDay(today)
      if (todays.reduce((spent, job) => spent + job.costUsd, 0) >= limits.dailyBudgetUsd) return refuse(503, 'budget')
      if (!(await verify(submission.data.token, ip))) return refuse(403, 'challenge')
      if (todays.filter((job) => !finished(job) && now() - job.createdAt < limits.concurrencyWindowMs).length >= limits.concurrentJobs) return refuse(429, 'busy')
      const visitor = createHash('sha256').update(`${today}:${ip}`).digest('hex')
      if (!(await quotas.take(today, visitor, limits.questionsPerDay))) return refuse(429, 'quota')

      const jobId = `${today.replaceAll('-', '')}-${uuid()}`
      await jobs.create({ id: jobId, createdAt: now(), status: 'queued', seq: -1, costUsd: 0 })
      await send({ v: 1, type: 'run', jobId, instance: 'ask', input: { question: submission.data.question } })
      return { status: 202, body: { jobId } }
    },

    async status(id: string): Promise<Reply> {
      const job = JobId.safeParse(id).success ? await jobs.get(id) : undefined
      if (!job) return refuse(404, 'unknown')
      if (!finished(job) && now() - job.createdAt > limits.staleAfterMs) return { status: 200, body: { status: 'failed', reason: 'timeout' } }
      const { status, step, output, reason } = job
      return { status: 200, body: { status, ...(step && { step }), ...(output && { output }), ...(reason && { reason }) } }
    },

    async warm(): Promise<Reply> {
      if (await quotas.claim('warm', now(), limits.warmIntervalMs)) await send({ v: 1, type: 'warm' })
      return { status: 202, body: {} }
    },

    async apply(message: unknown) {
      const event = Event.safeParse(message)
      if (event.success) await jobs.update(event.data.jobId, (job) => applied(job, event.data))
    },

    purge: () => jobs.purge(day(now() - limits.retentionDays * 86_400_000)),
  }
}

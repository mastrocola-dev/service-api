export type Step = { kind: 'model' | 'tool'; name?: string }

export type Answer = { outOfScope: boolean; answer: string; sources: string[] }

export type Reason = 'timeout' | 'budget' | 'redelivered' | 'error'

export type Job = { id: string; createdAt: number; status: 'queued' | 'running' | 'done' | 'failed'; seq: number; costUsd: number; step?: Step; output?: Answer; reason?: Reason }

export type JobStore = {
  create: (job: Job) => Promise<void>
  get: (id: string) => Promise<Job | undefined>
  update: (id: string, change: (job: Job) => Job | undefined) => Promise<void>
  ofDay: (day: string) => Promise<Job[]>
  purge: (beforeDay: string) => Promise<void>
}

export type QuotaStore = {
  take: (day: string, key: string, limit: number) => Promise<boolean>
  claim: (name: string, now: number, intervalMs: number) => Promise<boolean>
}

export type Entity = Record<string, string | number | boolean>

export type Table = {
  get: (partition: string, row: string) => Promise<Entity | undefined>
  mutate: (partition: string, row: string, change: (current?: Entity) => Entity | undefined) => Promise<boolean>
  list: (partition: string, prefix: string) => Promise<(Entity & { row: string })[]>
  purge: (beforePartition: string) => Promise<void>
}

export const dayOf = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`

const row = (id: string) => `job:${id}`

const toEntity = ({ id: _, step, output, reason, ...job }: Job): Entity => ({
  ...job,
  ...(step && { step: JSON.stringify(step) }),
  ...(output && { output: JSON.stringify(output) }),
  ...(reason && { reason }),
})

const toJob = (id: string, { step, output, ...entity }: Entity): Job => ({
  ...(entity as Omit<Job, 'id' | 'step' | 'output'>),
  id,
  ...(step && { step: JSON.parse(String(step)) }),
  ...(output && { output: JSON.parse(String(output)) }),
})

export function stores(table: Table): { jobs: JobStore; quotas: QuotaStore } {
  return {
    jobs: {
      async create(job) {
        await table.mutate(dayOf(job.id), row(job.id), () => toEntity(job))
      },
      async get(id) {
        const entity = await table.get(dayOf(id), row(id))
        return entity && toJob(id, entity)
      },
      async update(id, change) {
        await table.mutate(dayOf(id), row(id), (current) => {
          const next = current && change(toJob(id, current))
          return next && toEntity(next)
        })
      },
      async ofDay(day) {
        const entities = await table.list(day, 'job:')
        return entities.map(({ row, ...entity }) => toJob(row.slice('job:'.length), entity))
      },
      purge: table.purge,
    },
    quotas: {
      take: (day, key, limit) => table.mutate(day, `quota:${key}`, (current) => (Number(current?.count ?? 0) < limit ? { count: Number(current?.count ?? 0) + 1 } : undefined)),
      claim: (name, now, intervalMs) => table.mutate('state', name, (current) => (now - Number(current?.at ?? 0) >= intervalMs ? { at: now } : undefined)),
    },
  }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TableClient } from '@azure/data-tables'
import { azureTable } from '../src/table.ts'

type Stored = { partitionKey: string; rowKey: string; etag: string; [name: string]: unknown }

const failure = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { statusCode })

const service = () => {
  const rows = new Map<string, Stored>()
  const state = { version: 0, interference: 0, broken: false }
  const key = (partition: string, row: string) => `${partition}|${row}`
  const interfere = (id: string) => {
    if (state.interference-- > 0) rows.set(id, { ...(rows.get(id) as Stored), etag: `v${++state.version}`, count: 100 })
  }
  const client = {
    async getEntity(partition: string, row: string) {
      if (state.broken) throw failure(500)
      const found = rows.get(key(partition, row))
      if (!found) throw failure(404)
      return { ...found, timestamp: 'now', 'odata.metadata': 'meta' }
    },
    async createEntity(entity: Stored) {
      const id = key(entity.partitionKey, entity.rowKey)
      if (rows.has(id)) throw failure(409)
      rows.set(id, { ...entity, etag: `v${++state.version}` })
    },
    async updateEntity(entity: Stored, _mode: string, options: { etag: string }) {
      const id = key(entity.partitionKey, entity.rowKey)
      interfere(id)
      if (rows.get(id)?.etag !== options.etag) throw failure(412)
      rows.set(id, { ...entity, etag: `v${++state.version}` })
    },
    async *listEntities() {
      yield* rows.values()
    },
    async deleteEntity(partition: string, row: string) {
      rows.delete(key(partition, row))
    },
  }
  return { table: azureTable(client as unknown as TableClient), rows, state }
}

const increment = (current?: Record<string, unknown>) => ({ count: Number(current?.count ?? 0) + 1 })

test('returns only the stored properties', async () => {
  const { table } = service()
  await table.mutate('day', 'row', increment)
  assert.deepEqual(await table.get('day', 'row'), { count: 1 })
  assert.equal(await table.get('day', 'missing'), undefined)
})

test('creates, then replaces under the entity tag', async () => {
  const { table, rows } = service()
  assert.equal(await table.mutate('day', 'row', increment), true)
  assert.equal(await table.mutate('day', 'row', increment), true)
  assert.equal(rows.get('day|row')?.count, 2)
})

test('writes nothing when the change declines', async () => {
  const { table, rows } = service()
  assert.equal(await table.mutate('day', 'row', () => undefined), false)
  assert.equal(rows.size, 0)
})

test('reapplies the change on top of a concurrent write', async () => {
  const { table, rows, state } = service()
  await table.mutate('day', 'row', increment)
  state.interference = 2
  assert.equal(await table.mutate('day', 'row', increment), true)
  assert.equal(rows.get('day|row')?.count, 101)
})

test('gives up when concurrent writes keep winning', async () => {
  const { table, state } = service()
  await table.mutate('day', 'row', increment)
  state.interference = 99
  await assert.rejects(table.mutate('day', 'row', increment), /Concurrent updates kept winning on day\/row/)
})

test('does not hide failures that are not conflicts', async () => {
  const { table, state } = service()
  state.broken = true
  await assert.rejects(table.get('day', 'row'), /status 500/)
  await assert.rejects(table.mutate('day', 'row', increment), /status 500/)
})

test('lists rows with their keys and deletes what a purge finds', async () => {
  const { table, rows } = service()
  await table.mutate('day', 'job:1', increment)
  assert.deepEqual(await table.list('day', 'job:'), [{ count: 1, row: 'job:1' }])
  await table.purge('later')
  assert.equal(rows.size, 0)
})

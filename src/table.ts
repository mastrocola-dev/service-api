import { odata, type TableClient } from '@azure/data-tables'
import type { Entity, Table } from './store.ts'

const attempts = 5

const conflict = (error: unknown) => [409, 412].includes((error as { statusCode?: number }).statusCode ?? 0)

const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404

const properties = ({ partitionKey: _, rowKey: __, etag: ___, timestamp: ____, ...entity }: Record<string, unknown>) => Object.fromEntries(Object.entries(entity).filter(([name]) => !name.startsWith('odata.'))) as Entity

export function azureTable(client: TableClient): Table {
  const read = (partition: string, row: string) => client.getEntity(partition, row).catch((error) => (missing(error) ? undefined : Promise.reject(error)))

  return {
    async get(partition, row) {
      const entity = await read(partition, row)
      return entity && properties(entity)
    },

    async mutate(partition, row, change) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await read(partition, row)
        const next = change(current && properties(current))
        if (!next) return false
        const entity = { partitionKey: partition, rowKey: row, ...next }
        try {
          await (current ? client.updateEntity(entity, 'Replace', { etag: current.etag }) : client.createEntity(entity))
          return true
        } catch (error) {
          if (!conflict(error)) throw error
        }
      }
      throw new Error(`Concurrent updates kept winning on ${partition}/${row}`)
    },

    async list(partition, prefix) {
      const entities: (Entity & { row: string })[] = []
      for await (const entity of client.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${partition} and RowKey ge ${prefix} and RowKey lt ${`${prefix}￿`}` } })) entities.push({ ...properties(entity), row: String(entity.rowKey) })
      return entities
    },

    async purge(beforePartition) {
      for await (const entity of client.listEntities({ queryOptions: { filter: odata`PartitionKey lt ${beforePartition}`, select: ['partitionKey', 'rowKey'] } })) await client.deleteEntity(String(entity.partitionKey), String(entity.rowKey))
    },
  }
}

import type { Entity, Table } from '../../src/store.ts'

export function memoryTable(): Table & { rows: Map<string, Entity> } {
  const rows = new Map<string, Entity>()
  const key = (partition: string, row: string) => `${partition}|${row}`
  return {
    rows,
    get: async (partition, row) => rows.get(key(partition, row)),
    async mutate(partition, row, change) {
      const next = change(rows.get(key(partition, row)))
      if (next) rows.set(key(partition, row), next)
      return Boolean(next)
    },
    list: async (partition, prefix) => [...rows].filter(([id]) => id.startsWith(key(partition, prefix))).map(([id, entity]) => ({ ...entity, row: id.slice(partition.length + 1) })),
    async purge(beforePartition) {
      for (const id of rows.keys()) if (id.slice(0, id.indexOf('|')) < beforePartition) rows.delete(id)
    },
  }
}

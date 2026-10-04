import { TableClient } from '@azure/data-tables'
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions'
import { createApi, type Reply } from './api.ts'
import { env, send, token, verify } from './azure.ts'
import { stores, type Table } from './store.ts'
import { azureTable } from './table.ts'

let opened: Promise<Table> | undefined

function open() {
  opened ??= (async () => {
    const client = new TableClient(`https://${env('AzureWebJobsStorage__accountName')}.table.core.windows.net`, 'agent', { getToken: () => token('https://storage.azure.com') })
    await client.createTable()
    return azureTable(client)
  })()
  return opened
}

const table: Table = {
  get: async (...args) => (await open()).get(...args),
  mutate: async (...args) => (await open()).mutate(...args),
  list: async (...args) => (await open()).list(...args),
  purge: async (...args) => (await open()).purge(...args),
}

const api = createApi({ ...stores(table), verify, send: (message) => send('jobs', message) })

const reply = ({ status, body }: Reply): HttpResponseInit => ({ status, jsonBody: body })

export const submit = async (request: HttpRequest) => reply(await api.submit(await request.json().catch(() => undefined), request.headers.get('cf-connecting-ip') ?? undefined))

export const status = async (request: HttpRequest) => reply(await api.status(request.params.id ?? ''))

export const warm = async () => reply(await api.warm())

app.http('submit', { route: 'jobs', methods: ['POST'], authLevel: 'anonymous', handler: submit })
app.http('status', { route: 'jobs/{id}', methods: ['GET'], authLevel: 'anonymous', handler: status })
app.http('warm', { route: 'warm', methods: ['POST'], authLevel: 'anonymous', handler: warm })
app.serviceBusQueue('events', { queueName: 'events', connection: 'ServiceBus', handler: (message: unknown) => api.apply(message) })
app.timer('purge', { schedule: '0 0 3 * * *', handler: () => api.purge() })

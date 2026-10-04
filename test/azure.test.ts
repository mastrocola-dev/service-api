import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { secret, send, token, verify } from '../src/azure.ts'

Object.assign(process.env, {
  AZURE_CLIENT_ID: 'client',
  IDENTITY_ENDPOINT: 'http://identity.test/token',
  IDENTITY_HEADER: 'header',
  ServiceBus__fullyQualifiedNamespace: 'bus.test',
  TURNSTILE_SECRET_URI: 'https://vault.test/secrets/turnstile-secret-key',
})

type Call = { url: string; method: string; headers: Headers; body: string }

const network = (statuses: { identity?: number; vault?: number; bus?: number; turnstile?: number; human?: boolean } = {}) => {
  const calls: Call[] = []
  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: new Headers(init.headers), body: String(init.body ?? '') })
    if (input.startsWith('http://identity.test')) return Response.json({ access_token: new URL(input).searchParams.get('resource'), expires_on: '1790000000' }, { status: statuses.identity ?? 200 })
    if (input.startsWith('https://vault.test')) return Response.json({ value: 'turnstile-secret' }, { status: statuses.vault ?? 200 })
    if (input.startsWith('https://bus.test')) return new Response(null, { status: statuses.bus ?? 201 })
    return Response.json({ success: statuses.human ?? true }, { status: statuses.turnstile ?? 200 })
  })
  return calls
}

afterEach(() => mock.restoreAll())

test('asks the platform for a token as the app identity', async () => {
  const calls = network()
  assert.deepEqual(await token('https://storage.azure.com'), { token: 'https://storage.azure.com', expiresOnTimestamp: 1_790_000_000_000 })
  assert.equal(calls[0]?.url, 'http://identity.test/token?api-version=2019-08-01&resource=https%3A%2F%2Fstorage.azure.com&client_id=client')
  assert.equal(calls[0]?.headers.get('x-identity-header'), 'header')
})

test('fails when the platform refuses a token', async () => {
  network({ identity: 403 })
  await assert.rejects(token('https://vault.azure.net'), /Managed identity token for https:\/\/vault.azure.net failed: 403/)
})

test('reads a secret from Key Vault with the vault token', async () => {
  const calls = network()
  assert.equal(await secret('https://vault.test/secrets/turnstile-secret-key'), 'turnstile-secret')
  const read = calls.at(-1)
  assert.deepEqual([read?.url, read?.headers.get('authorization')], ['https://vault.test/secrets/turnstile-secret-key?api-version=7.4', 'Bearer https://vault.azure.net'])
})

test('fails when the secret cannot be read, naming it without its value', async () => {
  network({ vault: 403 })
  await assert.rejects(secret('https://vault.test/secrets/turnstile-secret-key'), /Reading \/secrets\/turnstile-secret-key failed: 403/)
})

test('sends a message to a queue with the Service Bus token', async () => {
  const calls = network()
  await send('jobs', { v: 1, type: 'warm' })
  const sent = calls.at(-1)
  assert.deepEqual([sent?.url, sent?.method, sent?.headers.get('authorization'), sent?.body], ['https://bus.test/jobs/messages', 'POST', 'Bearer https://servicebus.azure.net', '{"v":1,"type":"warm"}'])
})

test('fails when the queue refuses a message', async () => {
  network({ bus: 401 })
  await assert.rejects(send('jobs', {}), /Sending to jobs failed: 401/)
})

test('verifies a challenge with the secret, the token and the client address', async () => {
  const calls = network()
  assert.equal(await verify('challenge', '203.0.113.7'), true)
  const sent = calls.at(-1)
  assert.deepEqual([sent?.url, sent?.method], ['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'POST'])
  assert.deepEqual(Object.fromEntries(new URLSearchParams(sent?.body)), { secret: 'turnstile-secret', response: 'challenge', remoteip: '203.0.113.7' })
})

test('reports a refused challenge as not human', async () => {
  network({ human: false })
  assert.equal(await verify('challenge', '203.0.113.7'), false)
})

test('fails, rather than refusing the visitor, when the verification service is down', async () => {
  network({ turnstile: 500 })
  await assert.rejects(verify('challenge', '203.0.113.7'), /Turnstile verification failed: 500/)
})

test('names the missing setting', async () => {
  const { TURNSTILE_SECRET_URI, ...rest } = process.env
  process.env = rest
  try {
    await assert.rejects(verify('challenge', '203.0.113.7'), /Missing environment variable: TURNSTILE_SECRET_URI/)
  } finally {
    process.env = { ...rest, TURNSTILE_SECRET_URI }
  }
})

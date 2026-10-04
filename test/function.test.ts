import assert from 'node:assert/strict'
import { test } from 'node:test'
import functions from '@azure/functions'

const { status, submit } = await import('../src/function.ts')

const request = (method: string, body?: string, headers: Record<string, string> = {}, params: Record<string, string> = {}) => new functions.HttpRequest({ url: 'http://localhost/jobs', method, headers, params, ...(body !== undefined && { body: { string: body } }) })

test('answers an invalid submission with 400 and a JSON body, touching no service', async () => {
  for (const body of [undefined, 'not json', '{"question":"hi","token":"t"}']) {
    assert.deepEqual(await submit(request('POST', body, { 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' })), { status: 400, jsonBody: { error: 'invalid' } })
  }
})

test('requires the address set by the edge', async () => {
  const response = await submit(request('POST', '{"question":"Why multi-repo?","token":"t"}', { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }))
  assert.deepEqual(response, { status: 400, jsonBody: { error: 'invalid' } })
})

test('answers a malformed job id with 404, touching no service', async () => {
  assert.deepEqual(await status(request('GET', undefined, {}, { id: 'not-a-job' })), { status: 404, jsonBody: { error: 'unknown' } })
  assert.deepEqual(await status(request('GET')), { status: 404, jsonBody: { error: 'unknown' } })
})

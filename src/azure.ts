export function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export async function token(resource: string) {
  const query = new URLSearchParams({ 'api-version': '2019-08-01', resource, client_id: env('AZURE_CLIENT_ID') })
  const response = await fetch(`${env('IDENTITY_ENDPOINT')}?${query}`, { headers: { 'x-identity-header': env('IDENTITY_HEADER') } })
  if (!response.ok) throw new Error(`Managed identity token for ${resource} failed: ${response.status}`)
  const { access_token, expires_on } = (await response.json()) as { access_token: string; expires_on: string }
  return { token: access_token, expiresOnTimestamp: Number(expires_on) * 1000 }
}

const bearer = async (resource: string) => ({ authorization: `Bearer ${(await token(resource)).token}` })

export async function secret(uri: string) {
  const response = await fetch(`${uri}?api-version=7.4`, { headers: await bearer('https://vault.azure.net') })
  if (!response.ok) throw new Error(`Reading ${new URL(uri).pathname} failed: ${response.status}`)
  const { value } = (await response.json()) as { value: string }
  return value
}

export async function send(queue: string, message: object) {
  const response = await fetch(`https://${env('ServiceBus__fullyQualifiedNamespace')}/${queue}/messages`, { method: 'POST', headers: { ...(await bearer('https://servicebus.azure.net')), 'content-type': 'application/json' }, body: JSON.stringify(message) })
  if (!response.ok) throw new Error(`Sending to ${queue} failed: ${response.status}`)
}

export async function verify(challenge: string, ip: string) {
  const body = new URLSearchParams({ secret: await secret(env('TURNSTILE_SECRET_URI')), response: challenge, remoteip: ip })
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  if (!response.ok) throw new Error(`Turnstile verification failed: ${response.status}`)
  const { success } = (await response.json()) as { success: boolean }
  return success === true
}

import { apiFetch, fetchWithAuth } from '../../apiClient'

export type ApiErrorBody = { error?: string; message?: string }

export class ApiClientError extends Error {
  status: number
  body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody, fallback: string) {
    super(String(body.message || body.error || fallback))
    this.status = status
    this.body = body
  }
}

export async function apiGet<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const qs =
    query && Object.keys(query).length
      ? `?${new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v != null && String(v).trim() !== '')
            .map(([k, v]) => [k, String(v)]),
        ).toString()}`
      : ''
  const res = await fetchWithAuth(`${path}${qs}`, { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody & T
  if (!res.ok) {
    throw new ApiClientError(res.status, body, `http_${res.status}`)
  }
  return body as T
}

export async function apiPost<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(path, {
    method: 'POST',
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody & T
  if (!res.ok) {
    throw new ApiClientError(res.status, body, `http_${res.status}`)
  }
  return body as T
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithAuth(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as ApiErrorBody & T
  if (!res.ok) {
    throw new ApiClientError(res.status, data, `http_${res.status}`)
  }
  return data as T
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithAuth(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as ApiErrorBody & T
  if (!res.ok) {
    throw new ApiClientError(res.status, data, `http_${res.status}`)
  }
  return data as T
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetchWithAuth(path, { method: 'DELETE' })
  const data = (await res.json().catch(() => ({}))) as ApiErrorBody & T
  if (!res.ok) {
    throw new ApiClientError(res.status, data, `http_${res.status}`)
  }
  return data as T
}

export { apiFetch, fetchWithAuth }

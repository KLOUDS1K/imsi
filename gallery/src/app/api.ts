/** Every call the browser makes. Admin routes fail with 401 unless signed in. */
import type { BrowseResult, Folder, Photo, StatsReport } from '../shared/types'

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error((body.error as string) ?? `Request failed (${res.status})`)
  return body as T
}

export interface TreeResult {
  folders: Folder[]
  admin: boolean
  siteTitle: string
}

export const api = {
  tree: () => request<TreeResult>('/api/tree'),

  browse: (folderId: string) =>
    request<BrowseResult>(`/api/browse?folder=${encodeURIComponent(folderId)}`),

  search: (query: string) =>
    request<{ query: string; folders: Folder[]; photos: Photo[] }>(
      `/api/search?q=${encodeURIComponent(query)}`,
    ),

  /**
   * The counter beacon. Deliberately fire-and-forget and `keepalive`, so it
   * neither delays the view nor is lost if the page is closed right after.
   */
  hit: (body: { visit?: boolean; folder?: string }) => {
    void fetch('/api/hit', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  },

  stats: () => request<StatsReport>('/api/admin/stats'),

  unlock: (folderId: string, password: string) =>
    request<{ ok: true }>('/api/unlock', {
      method: 'POST',
      body: JSON.stringify({ folderId, password }),
    }),

  session: {
    status: () =>
      request<{ authenticated: boolean; username: string | null }>('/api/admin/session'),
    needsSetup: () =>
      request<{ needsSetup: boolean; requiresKey: boolean; setupAllowed: boolean }>('/api/admin/setup'),
    createFirstAdmin: (username: string, password: string, setupKey: string) =>
      request<{ ok: true }>('/api/admin/setup', {
        method: 'POST',
        headers: setupKey ? { 'x-setup-key': setupKey } : {},
        body: JSON.stringify({ username, password }),
      }),
    login: (username: string, password: string) =>
      request<{ ok: true; username: string }>('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  },

  folders: {
    create: (input: { parentId: string; name: string; note?: string; date?: string | null }) =>
      request<{ ok: true; folder: Folder }>('/api/admin/folders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    patch: (id: string, patch: Record<string, unknown>) =>
      request<{ ok: true; folder: Folder }>(`/api/admin/folders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      request<{ ok: true; deletedFolders: number; deletedPhotos: number }>(
        `/api/admin/folders/${id}`,
        { method: 'DELETE' },
      ),
  },

  photos: {
    patch: (id: string, patch: Record<string, unknown>) =>
      request<{ ok: true; photo: Photo }>(`/api/admin/photos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) => request<{ ok: true }>(`/api/admin/photos/${id}`, { method: 'DELETE' }),
    commit: (id: string, body: Record<string, unknown>) =>
      request<{ ok: true; id: string }>(`/api/admin/photos/${id}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    uploadEdited: (id: string, revision: string, kind: 'full' | 'preview' | 'thumb', blob: Blob) =>
      request<{ ok: true; key: string }>(`/api/admin/photos/${id}/edited/${revision}/${kind}`, {
        method: 'PUT',
        headers: { 'content-type': blob.type },
        body: blob,
      }),
    commitEdited: (id: string, body: { revision: string; filename: string; width: number; height: number }) =>
      request<{ ok: true; photo: Photo }>(`/api/admin/photos/${id}/edited`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    removeEdited: (id: string) =>
      request<{ ok: true }>(`/api/admin/photos/${id}/edited`, { method: 'DELETE' }),
    discardEditedUpload: (id: string, revision: string) =>
      request<{ ok: true }>(`/api/admin/photos/${id}/edited/${revision}`, { method: 'DELETE' }),
  },
}

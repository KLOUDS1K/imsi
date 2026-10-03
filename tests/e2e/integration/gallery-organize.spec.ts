import { expect, test } from '@playwright/test'

const TRIP = '11111111-1111-4111-8111-111111111111'
const CLIENTS = '22222222-2222-4222-8222-222222222222'
const PHOTO = '33333333-3333-4333-8333-333333333333'
const folder = (id: string, name: string, parentId = '') => ({
  id, parentId, name, note: '', date: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
})

test('a mobile owner can select a folder and photo and move both in one action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let tripParent = ''
  let photoParent = ''
  const calls: unknown[] = []
  const photo = {
    id: PHOTO, folderId: '', title: 'Track day', date: null, location: '', description: '',
    width: 1, height: 1, placeholder: null, filename: 'track.jpg', size: 30, type: 'image/jpeg',
    createdAt: 1, thumbUrl: '/track.jpg', previewUrl: '/track.jpg', originalThumbUrl: '/track.jpg',
    originalPreviewUrl: '/track.jpg', originalUrl: '/track.jpg', editedUrl: null,
    editedPreviewUrl: null, editedThumbUrl: null, editedFilename: null, editedSize: null,
    editedType: null, editedWidth: null, editedHeight: null, editedUpdatedAt: null,
  }
  await page.route('**/api/tree', (route) => route.fulfill({ json: {
    admin: true, siteTitle: 'KLOUD', folders: [folder(TRIP, 'Trip', tripParent), folder(CLIENTS, 'Clients')],
  } }))
  await page.route('**/api/browse?**', (route) => {
    const id = new URL(route.request().url()).searchParams.get('folder') ?? ''
    const folders = [folder(TRIP, 'Trip', tripParent), folder(CLIENTS, 'Clients')]
      .filter((item) => item.parentId === id)
      .map((item) => ({ ...item, covers: [], photoCount: 0, folderCount: 0 }))
    return route.fulfill({ json: {
      folder: id === CLIENTS ? folder(CLIENTS, 'Clients') : null,
      path: id === CLIENTS ? [folder(CLIENTS, 'Clients')] : [],
      folders, photos: photoParent === id ? [{ ...photo, folderId: id }] : [],
      admin: true, lock: null,
    } })
  })
  await page.route('**/api/admin/session', (route) => route.fulfill({ json: { authenticated: true, username: 'owner' } }))
  await page.route('**/api/hit', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/admin/move', async (route) => {
    const body = route.request().postDataJSON()
    calls.push(body)
    tripParent = body.destination
    photoParent = body.destination
    await route.fulfill({ json: { ok: true, movedPhotos: 1, movedFolders: 1 } })
  })
  await page.route('**/track.jpg', (route) => route.fulfill({ status: 200, body: '' }))

  await page.goto('/')
  await page.getByRole('button', { name: 'Organize' }).click()
  await page.getByRole('checkbox', { name: 'Select folder Trip' }).click()
  await page.getByRole('checkbox', { name: 'Select photo Track day' }).click()
  await expect(page.locator('.pane__selected')).toHaveText('2 selected')
  await page.getByRole('button', { name: 'Move', exact: true }).click()
  await page.getByLabel('Destination').selectOption(CLIENTS)
  await page.locator('[data-role="sheet"]').getByRole('button', { name: 'Move', exact: true }).click()

  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]).toEqual({ destination: CLIENTS, photoIds: [PHOTO], folderIds: [TRIP] })
  await expect(page.getByRole('button', { name: 'Organize' })).toBeVisible()
  await expect(page.locator('.grid--photos .tile')).toHaveCount(0)
  await expect(page.locator('.grid--folders .card')).toHaveCount(1)
})

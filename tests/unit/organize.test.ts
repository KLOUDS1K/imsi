import { describe, expect, it } from 'vitest'
import { validateFolderMove } from '../../worker/organize'

const folders = [
  { id: 'trip', parent_id: '', name: 'Trip' },
  { id: 'day', parent_id: 'trip', name: 'Day 1' },
  { id: 'destination', parent_id: '', name: 'Clients' },
  { id: 'existing', parent_id: 'destination', name: 'Day 1' },
  { id: 'second', parent_id: '', name: 'Day 1' },
]

describe('organizing folders', () => {
  it('allows a folder to move to the root or an unrelated branch', () => {
    expect(() => validateFolderMove(folders, ['trip'], '')).not.toThrow()
    expect(() => validateFolderMove(folders, ['trip'], 'destination')).not.toThrow()
  })

  it('rejects cycles and missing destinations before changing any rows', () => {
    expect(() => validateFolderMove(folders, ['trip'], 'day')).toThrow(/inside itself/)
    expect(() => validateFolderMove(folders, ['trip'], 'trip')).toThrow(/inside itself/)
    expect(() => validateFolderMove(folders, ['trip'], 'missing')).toThrow(/Destination folder not found/)
    expect(() => validateFolderMove(folders, ['missing'], '')).toThrow(/Folder not found/)
  })

  it('rejects names already in the destination and duplicate names in one selection', () => {
    expect(() => validateFolderMove(folders, ['day'], 'destination')).toThrow(/already exists/)
    expect(() => validateFolderMove(folders, ['day', 'second'], '')).toThrow(/already exists/)
    expect(() => validateFolderMove(folders, ['existing', 'day'], 'destination')).toThrow(/already exists/)
  })
})

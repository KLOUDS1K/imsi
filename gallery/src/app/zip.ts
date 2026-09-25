/**
 * A minimal ZIP writer, store-only.
 *
 * Why the browser and not the worker: zipping means running a CRC-32 over
 * every byte, and this zone is on a plan whose per-request CPU budget is
 * measured in milliseconds. A few hundred megabytes of photos would blow that
 * long before the first file finished. The browser has the cycles to spare, so
 * the archive is assembled here and the worker only ever streams originals.
 *
 * Store, never deflate: JPEG, PNG and WebP are already compressed, so deflate
 * costs real time to save nothing.
 *
 * ZIP64 fields are written only for the entries and archives that actually
 * need them, so a small download stays a plain, maximally compatible zip.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, which is what a zip entry carries. */
function dosStamp(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  }
}

class Writer {
  private readonly bytes: number[] = []
  u16(v: number): this {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }
  /** 64-bit little endian, built from a JS number (safe to 2^53). */
  u64(v: number): this {
    const low = v >>> 0
    const high = Math.floor(v / 0x100000000)
    return this.u32(low).u32(high)
  }
  raw(data: Uint8Array): this {
    for (const b of data) this.bytes.push(b)
    return this
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

const U32_MAX = 0xffffffff
const encoder = new TextEncoder()

interface Entry {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  date: number
  time: number
}

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void> | void
  close(): Promise<void> | void
}

/**
 * Feeds entries out to a sink as they are added, so the archive is never all
 * in memory at once — only the file currently being written.
 */
export class ZipStream {
  private readonly entries: Entry[] = []
  private offset = 0

  constructor(private readonly sink: ZipSink) {}

  private async emit(bytes: Uint8Array): Promise<void> {
    await this.sink.write(bytes)
    this.offset += bytes.length
  }

  async add(name: string, data: Uint8Array, modified: Date): Promise<void> {
    const nameBytes = encoder.encode(name)
    const crc = crc32(data)
    const { date, time } = dosStamp(modified)
    const entry: Entry = { name: nameBytes, crc, size: data.length, offset: this.offset, date, time }
    const big = data.length > U32_MAX

    const header = new Writer()
      .u32(0x04034b50)
      .u16(big ? 45 : 20) // version needed: 4.5 once ZIP64 is in play
      .u16(0x0800) // bit 11: the name is UTF-8
      .u16(0) // stored
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(big ? U32_MAX : data.length)
      .u32(big ? U32_MAX : data.length)
      .u16(nameBytes.length)
      .u16(big ? 20 : 0)
      .raw(nameBytes)

    if (big) header.u16(0x0001).u16(16).u64(data.length).u64(data.length)

    await this.emit(header.done())
    await this.emit(data)
    this.entries.push(entry)
  }

  /** Writes the central directory and closes the sink. */
  async finish(): Promise<void> {
    const start = this.offset

    for (const entry of this.entries) {
      const bigSize = entry.size > U32_MAX
      const bigOffset = entry.offset > U32_MAX
      const extra = new Writer()
      if (bigSize) extra.u64(entry.size).u64(entry.size)
      if (bigOffset) extra.u64(entry.offset)
      const extraBytes = extra.done()

      const record = new Writer()
        .u32(0x02014b50)
        .u16(bigSize || bigOffset ? 45 : 20)
        .u16(bigSize || bigOffset ? 45 : 20)
        .u16(0x0800)
        .u16(0)
        .u16(entry.time)
        .u16(entry.date)
        .u32(entry.crc)
        .u32(bigSize ? U32_MAX : entry.size)
        .u32(bigSize ? U32_MAX : entry.size)
        .u16(entry.name.length)
        .u16(extraBytes.length ? extraBytes.length + 4 : 0)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attributes
        .u32(0) // external attributes
        .u32(bigOffset ? U32_MAX : entry.offset)
        .raw(entry.name)

      if (extraBytes.length) record.u16(0x0001).u16(extraBytes.length).raw(extraBytes)
      await this.emit(record.done())
    }

    const size = this.offset - start
    const needsZip64 = start > U32_MAX || size > U32_MAX || this.entries.length > 0xffff

    if (needsZip64) {
      const zip64Start = this.offset
      await this.emit(
        new Writer()
          .u32(0x06064b50)
          .u64(44) // size of this record, minus its own 12-byte prefix
          .u16(45)
          .u16(45)
          .u32(0)
          .u32(0)
          .u64(this.entries.length)
          .u64(this.entries.length)
          .u64(size)
          .u64(start)
          .done(),
      )
      await this.emit(new Writer().u32(0x07064b50).u32(0).u64(zip64Start).u32(1).done())
    }

    await this.emit(
      new Writer()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(needsZip64 ? 0xffff : this.entries.length)
        .u16(needsZip64 ? 0xffff : this.entries.length)
        .u32(needsZip64 ? U32_MAX : size)
        .u32(needsZip64 ? U32_MAX : start)
        .u16(0)
        .done(),
    )

    await this.sink.close()
  }
}

/**
 * Writes straight to a file the user picked, so the archive never has to fit
 * in memory. Only Chromium desktop offers this; everywhere else the caller
 * falls back to collecting the parts.
 */
export async function pickFileSink(
  suggestedName: string,
): Promise<{ sink: ZipSink; done: () => void } | null> {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>
    }
  ).showSaveFilePicker
  if (!picker) return null

  try {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    })
    const writable = await (
      handle as FileSystemFileHandle & { createWritable: () => Promise<FileSystemWritableFileStream> }
    ).createWritable()
    return {
      sink: {
        // A fresh ArrayBuffer-backed copy: the stream's type wants exactly
        // that, and the caller is free to reuse its buffer afterwards.
        write: (chunk) => writable.write(new Uint8Array(chunk).slice().buffer),
        close: () => writable.close(),
      },
      done: () => undefined,
    }
  } catch (err) {
    // A cancelled picker is a cancelled download, not a reason to fall back.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return null
  }
}

/** The fallback: keep the parts, hand over one blob at the end. */
export function memorySink(filename: string): { sink: ZipSink; done: () => void } {
  const parts: BlobPart[] = []
  return {
    sink: {
      write: (chunk) => {
        // Copy: the caller may reuse the buffer, and a Blob holds a reference.
        parts.push(chunk.slice())
      },
      close: () => undefined,
    },
    done: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.append(a)
      a.click()
      setTimeout(() => {
        a.remove()
        URL.revokeObjectURL(url)
      }, 60_000)
    },
  }
}

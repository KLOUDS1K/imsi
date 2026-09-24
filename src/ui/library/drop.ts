/**
 * Files from a drag-and-drop, including whole folders (walked recursively via
 * the File System Entries API). Files found inside a dropped folder carry a
 * `webkitRelativePath` ("Trip/Day 1/IMG_0001.jpg") so the library files them
 * under matching virtual folders, like the folder picker does.
 */

type Entry = FileSystemEntry;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  return new Promise((resolve) => {
    // readEntries returns at most ~100 entries per call: keep reading until empty.
    const step = (): void =>
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) resolve(out);
          else {
            out.push(...batch);
            step();
          }
        },
        () => resolve(out),
      );
    step();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function withRelativePath(file: File, path: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
  } catch {
    // Non-configurable in some engines: the file still imports, just without its folder.
  }
  return file;
}

async function walk(entry: Entry, prefix: string, out: File[], depth: number): Promise<void> {
  if (entry.isFile) {
    const f = await entryFile(entry as FileSystemFileEntry);
    if (f) out.push(prefix ? withRelativePath(f, `${prefix}${f.name}`) : f);
  } else if (entry.isDirectory && depth < 12) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      if (child.name.startsWith('.')) continue;
      await walk(child, `${prefix}${entry.name}/`, out, depth + 1);
    }
  }
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (entries.some((e) => e?.isDirectory)) {
    const out: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const e = entries[i];
      if (e) await walk(e, '', out, 0);
      else {
        const f = items[i].getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }
  return [...dt.files];
}

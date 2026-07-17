import type { ConvertedSession, SessionConversionResult } from './chatGptSessionConverter.js';

type ZipEntry = {
  name: string;
  text: string;
  date: Date;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  bytes.forEach((byte) => {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  });
  return (value ^ 0xffffffff) >>> 0;
}

function littleEndian16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function littleEndian32(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function getZipDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: ((date.getHours() & 0x1f) << 11)
      | ((date.getMinutes() & 0x3f) << 5)
      | Math.floor(date.getSeconds() / 2),
    dosDate: (((year - 1980) & 0x7f) << 9)
      | (((date.getMonth() + 1) & 0x0f) << 5)
      | (date.getDate() & 0x1f),
  };
}

function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const fileName = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const checksum = crc32(data);
    const { dosTime, dosDate } = getZipDosDateTime(entry.date);
    const localHeader = concatBytes([
      littleEndian32(0x04034b50),
      littleEndian16(20),
      littleEndian16(0),
      littleEndian16(0),
      littleEndian16(dosTime),
      littleEndian16(dosDate),
      littleEndian32(checksum),
      littleEndian32(data.length),
      littleEndian32(data.length),
      littleEndian16(fileName.length),
      littleEndian16(0),
      fileName,
    ]);
    localParts.push(localHeader, data);

    centralParts.push(concatBytes([
      littleEndian32(0x02014b50),
      littleEndian16(20),
      littleEndian16(20),
      littleEndian16(0),
      littleEndian16(0),
      littleEndian16(dosTime),
      littleEndian16(dosDate),
      littleEndian32(checksum),
      littleEndian32(data.length),
      littleEndian32(data.length),
      littleEndian16(fileName.length),
      littleEndian16(0),
      littleEndian16(0),
      littleEndian16(0),
      littleEndian16(0),
      littleEndian32(0),
      littleEndian32(offset),
      fileName,
    ]));
    offset += localHeader.length + data.length;
  });

  const centralDirectory = concatBytes(centralParts);
  const endRecord = concatBytes([
    littleEndian32(0x06054b50),
    littleEndian16(0),
    littleEndian16(0),
    littleEndian16(entries.length),
    littleEndian16(entries.length),
    littleEndian32(centralDirectory.length),
    littleEndian32(offset),
    littleEndian16(0),
  ]);
  const archive = concatBytes([...localParts, centralDirectory, endRecord]);
  const buffer = new ArrayBuffer(archive.byteLength);
  new Uint8Array(buffer).set(archive);
  return new Blob([buffer], { type: 'application/zip' });
}

function sanitizeFileToken(value: string, fallback: string): string {
  return (value || fallback)
    .replace(/\.[^.]+$/u, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || fallback;
}

function getTimestampToken(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function buildCpaZipEntries(converted: ConvertedSession[], date: Date): ZipEntry[] {
  const usedNames = new Map<string, number>();
  return converted.map((item, index) => {
    const baseName = sanitizeFileToken(item.name || item.email || '', `account-${index + 1}`);
    const seen = usedNames.get(baseName) || 0;
    usedNames.set(baseName, seen + 1);
    return {
      name: `${seen ? `${baseName}-${seen + 1}` : baseName}.json`,
      text: JSON.stringify(item.cpa, null, 2),
      date,
    };
  });
}

export function buildSessionDownload(result: SessionConversionResult, now = new Date()) {
  const timestamp = getTimestampToken(now);
  if (result.format === 'cpa' && result.converted.length > 1) {
    return {
      blob: buildZip(buildCpaZipEntries(result.converted, now)),
      fileName: `cpa-batch.${timestamp}.zip`,
    };
  }
  const first = result.converted[0];
  const base = sanitizeFileToken(first?.email || first?.name || result.format, result.format);
  return {
    blob: new Blob([result.outputText], { type: 'application/json;charset=utf-8' }),
    fileName: `${base}.${result.format}.${timestamp}.json`,
  };
}

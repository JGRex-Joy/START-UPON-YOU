import type { FitsHeader, FitsImage, HeaderValue, SpectralCube } from '../../types';
import { buildWcs } from './wcs';

const BLOCK = 2880;
const CARD = 80;

export interface FitsHdu {
  index: number;
  extname: string;
  header: FitsHeader;
  bitpix: number;
  naxis: number[];
  dataOffset: number;
  dataBytes: number;
  isImage: boolean;
}

export interface FitsFile {
  buffer: ArrayBuffer;
  hdus: FitsHdu[];
}

function parseValue(raw: string): { value: HeaderValue; comment?: string } {
  const s = raw.trim();
  if (s.startsWith("'")) {
    let i = 1;
    let out = '';
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        break;
      }
      out += s[i++];
    }
    const rest = s.slice(i + 1);
    const c = rest.indexOf('/');
    return { value: out.replace(/\s+$/, ''), comment: c >= 0 ? rest.slice(c + 1).trim() : undefined };
  }
  const slash = s.indexOf('/');
  const body = (slash >= 0 ? s.slice(0, slash) : s).trim();
  const comment = slash >= 0 ? s.slice(slash + 1).trim() : undefined;
  if (body === 'T') return { value: true, comment };
  if (body === 'F') return { value: false, comment };
  if (body === '') return { value: null, comment };
  const n = Number(body.replace(/[dD]/, 'e'));
  return { value: Number.isNaN(n) ? body : n, comment };
}

export function readHeader(bytes: Uint8Array, start: number): { header: FitsHeader; end: number } {
  const header: FitsHeader = {};
  let off = start;
  let done = false;
  const dec = new TextDecoder('ascii');
  while (!done) {
    if (off + BLOCK > bytes.length) throw new Error('Truncated FITS header');
    for (let c = 0; c < BLOCK / CARD; c++) {
      const card = dec.decode(bytes.subarray(off + c * CARD, off + (c + 1) * CARD));
      const key = card.slice(0, 8).trim();
      if (key === 'END') {
        done = true;
        break;
      }
      if (!key || key === 'COMMENT' || key === 'HISTORY' || key === 'CONTINUE') continue;
      if (card[8] !== '=') continue;
      header[key] = parseValue(card.slice(10));
    }
    off += BLOCK;
  }
  return { header, end: off };
}

const num = (h: FitsHeader, k: string, d = 0): number => {
  const v = h[k]?.value;
  return typeof v === 'number' ? v : d;
};

/** Describe one HDU from its header (data size, shape, image-ness). `dataOffset` is where its data starts. */
export function makeHdu(index: number, header: FitsHeader, dataOffset: number): FitsHdu {
  const bitpix = num(header, 'BITPIX', 8);
  const naxisN = num(header, 'NAXIS', 0);
  const naxis: number[] = [];
  for (let i = 1; i <= naxisN; i++) naxis.push(num(header, `NAXIS${i}`, 0));
  const pcount = num(header, 'PCOUNT', 0);
  const gcount = num(header, 'GCOUNT', 1);
  const elements = naxis.length ? naxis.reduce((a, b) => a * b, 1) : 0;
  const dataBytes = (Math.abs(bitpix) / 8) * gcount * (elements + pcount);
  const xt = header['XTENSION']?.value;
  const isImage = (xt === undefined || xt === 'IMAGE') && naxis.length >= 2 && elements > 0 && header['ZIMAGE']?.value !== true;
  const extnameRaw = header['EXTNAME']?.value;
  return {
    index,
    extname: typeof extnameRaw === 'string' ? extnameRaw : index === 0 ? 'PRIMARY' : `HDU${index}`,
    header, bitpix, naxis, dataOffset, dataBytes, isImage,
  };
}

/** Parse the structure of a FITS file (all HDU headers). Pixel data is read lazily. */
export function parseFits(buffer: ArrayBuffer): FitsFile {
  const bytes = new Uint8Array(buffer);
  const sig = new TextDecoder('ascii').decode(bytes.subarray(0, 9));
  if (sig !== 'SIMPLE  =') throw new Error('Not a FITS file (missing SIMPLE keyword). The server may have returned an error page.');
  const hdus: FitsHdu[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + BLOCK > bytes.length) break;
    const { header, end } = readHeader(bytes, off);
    const hdu = makeHdu(hdus.length, header, end);
    hdus.push(hdu);
    off = end + Math.ceil(hdu.dataBytes / BLOCK) * BLOCK;
  }
  if (hdus.length === 0) throw new Error('No HDUs found in FITS file');
  return { buffer, hdus };
}

/** Read one 2-D plane (slice) of an image HDU as Float32 with BSCALE/BZERO/BLANK applied. */
export function readPlane(file: FitsFile, hdu: FitsHdu, plane = 0): Float32Array {
  const [w, h] = hdu.naxis;
  const n = w * h;
  const bytesPer = Math.abs(hdu.bitpix) / 8;
  const start = hdu.dataOffset + plane * n * bytesPer;
  if (start + n * bytesPer > file.buffer.byteLength) throw new Error('FITS data truncated');
  const view = new DataView(file.buffer, start, n * bytesPer);
  const out = new Float32Array(n);
  const bscale = num(hdu.header, 'BSCALE', 1);
  const bzero = num(hdu.header, 'BZERO', 0);
  const blankRaw = hdu.header['BLANK']?.value;
  const blank = typeof blankRaw === 'number' ? blankRaw : null;
  for (let i = 0; i < n; i++) {
    let v: number;
    switch (hdu.bitpix) {
      case -32: v = view.getFloat32(i * 4, false); break;
      case -64: v = view.getFloat64(i * 8, false); break;
      case 8: v = view.getUint8(i); break;
      case 16: v = view.getInt16(i * 2, false); break;
      case 32: v = view.getInt32(i * 4, false); break;
      case 64: v = Number(view.getBigInt64(i * 8, false)); break;
      default: throw new Error(`Unsupported BITPIX ${hdu.bitpix}`);
    }
    if (blank !== null && hdu.bitpix > 0 && v === blank) out[i] = NaN;
    else out[i] = hdu.bitpix > 0 ? v * bscale + bzero : v;
  }
  return out;
}

export interface BinTableColumn { name: string; unit: string | null; format: string }
export interface BinTable {
  columns: BinTableColumn[];
  nrows: number;
  /** rows[r][c]: number | string, or null for array cells / null values / unsupported types. */
  rows: (number | string | null)[][];
}

const TFORM_BYTES: Record<string, number> = { L: 1, B: 1, I: 2, J: 4, K: 8, E: 4, D: 8, C: 8, M: 16, A: 1 };

/** Read a FITS BINTABLE (big-endian, scalar numeric and string columns). Array-valued cells come back as null. */
export function readBinTable(file: FitsFile, hdu: FitsHdu): BinTable {
  if (hdu.header['XTENSION']?.value !== 'BINTABLE') throw new Error(`HDU ${hdu.extname} is not a binary table`);
  const nfields = num(hdu.header, 'TFIELDS', 0);
  const rowBytes = hdu.naxis[0] ?? 0;
  const nrows = hdu.naxis[1] ?? 0;
  const cols: { name: string; unit: string | null; format: string; code: string; repeat: number; offset: number; scale: number; zero: number; nul: number | null }[] = [];
  let offset = 0;
  for (let i = 1; i <= nfields; i++) {
    const format = strVal(hdu.header, `TFORM${i}`) ?? '';
    const m = /^(\d*)([LXBIJKAEDCM])/.exec(format.trim());
    if (!m) throw new Error(`Unsupported TFORM${i} '${format}' in ${hdu.extname}`);
    const repeat = m[1] === '' ? 1 : Number(m[1]);
    const code = m[2];
    const size = code === 'X' ? Math.ceil(repeat / 8) : TFORM_BYTES[code] * repeat;
    const nul = hdu.header[`TNULL${i}`]?.value;
    cols.push({
      name: strVal(hdu.header, `TTYPE${i}`) ?? `COL${i}`, unit: strVal(hdu.header, `TUNIT${i}`), format: format.trim(), code, repeat, offset,
      scale: num(hdu.header, `TSCAL${i}`, 1), zero: num(hdu.header, `TZERO${i}`, 0), nul: typeof nul === 'number' ? nul : null,
    });
    offset += size;
  }
  if (offset > rowBytes) throw new Error(`Table ${hdu.extname}: columns need ${offset} bytes per row but NAXIS1 is ${rowBytes}`);
  if (hdu.dataOffset + rowBytes * nrows > file.buffer.byteLength) throw new Error('FITS table data truncated');
  const view = new DataView(file.buffer, hdu.dataOffset, rowBytes * nrows);
  const dec = new TextDecoder('ascii');
  const rows: (number | string | null)[][] = [];
  for (let r = 0; r < nrows; r++) {
    const base = r * rowBytes;
    rows.push(cols.map((c) => {
      const p = base + c.offset;
      if (c.code === 'A') return dec.decode(new Uint8Array(file.buffer, hdu.dataOffset + p, c.repeat)).replace(/[\0\s]+$/, '');
      if (c.repeat !== 1 || c.code === 'X' || c.code === 'L' || c.code === 'C' || c.code === 'M') return null;
      let v: number;
      switch (c.code) {
        case 'B': v = view.getUint8(p); break;
        case 'I': v = view.getInt16(p, false); break;
        case 'J': v = view.getInt32(p, false); break;
        case 'K': v = Number(view.getBigInt64(p, false)); break;
        case 'E': v = view.getFloat32(p, false); break;
        default: v = view.getFloat64(p, false);
      }
      if (c.nul !== null && v === c.nul) return null;
      return v * c.scale + c.zero;
    }));
  }
  return { columns: cols.map((c) => ({ name: c.name, unit: c.unit, format: c.format })), nrows, rows };
}

export function findHdu(file: FitsFile, name: string): FitsHdu | undefined {
  return file.hdus.find((h) => h.extname.toUpperCase() === name.toUpperCase());
}

/** Choose the science image HDU: `IMAGE` (SPHEREx) if present, else the first 2-D+ image HDU. */
export function pickScienceHdu(file: FitsFile): FitsHdu | undefined {
  const named = findHdu(file, 'IMAGE');
  if (named?.isImage) return named;
  return file.hdus.find((h) => h.isImage);
}

const strVal = (h: FitsHeader, k: string): string | null => {
  const v = h[k]?.value;
  return typeof v === 'string' ? v : null;
};

export function toFitsImage(file: FitsFile, hdu: FitsHdu, plane = 0): FitsImage {
  return {
    width: hdu.naxis[0],
    height: hdu.naxis[1],
    data: readPlane(file, hdu, plane),
    header: hdu.header,
    wcs: buildWcs(hdu.header),
    extname: hdu.extname,
    bunit: strVal(hdu.header, 'BUNIT'),
  };
}

const UNIT_TO_UM: Record<string, number> = {
  m: 1e6, meter: 1e6, um: 1, micron: 1, microns: 1, μm: 1, nm: 1e-3, angstrom: 1e-4, a: 1e-4,
};

/**
 * Wavelengths per channel for a 3-D cube — only when the header carries a *linear* spectral WCS.
 * Tabular (WAVE-TAB) or missing axes yield null: wavelengths are never guessed.
 */
export function cubeWavelengths(header: FitsHeader, depth: number): (number | null)[] | null {
  const ctype = strVal(header, 'CTYPE3');
  if (!ctype || !/^WAVE\s*$/i.test(ctype.trim())) return null;
  const crval = header['CRVAL3']?.value;
  const crpix = header['CRPIX3']?.value ?? 1;
  const cdelt = header['CDELT3']?.value ?? header['CD3_3']?.value;
  if (typeof crval !== 'number' || typeof crpix !== 'number' || typeof cdelt !== 'number') return null;
  const unit = (strVal(header, 'CUNIT3') ?? 'm').trim().toLowerCase();
  const f = UNIT_TO_UM[unit];
  if (f === undefined) return null;
  return Array.from({ length: depth }, (_, k) => (crval + (k + 1 - crpix) * cdelt) * f);
}

export function toSpectralCube(file: FitsFile, hdu: FitsHdu): SpectralCube {
  if (hdu.naxis.length < 3 || hdu.naxis[2] < 2) throw new Error('HDU has no third (spectral) axis');
  const [width, height, depth] = hdu.naxis;
  const slices: (Float32Array | null)[] = new Array(depth).fill(null);
  return {
    width,
    height,
    depth,
    slices,
    header: hdu.header,
    wcs: buildWcs(hdu.header),
    wavelengthsUm: cubeWavelengths(hdu.header, depth),
    bunit: strVal(hdu.header, 'BUNIT'),
    readSlice(i: number) {
      const cached = slices[i];
      if (cached) return cached;
      const s = readPlane(file, hdu, i);
      slices[i] = s;
      return s;
    },
  };
}

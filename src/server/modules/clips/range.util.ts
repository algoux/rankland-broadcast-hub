export type ParsedRange =
  | { kind: 'full'; start: number; end: number; contentLength: number }
  | { kind: 'partial'; start: number; end: number; contentLength: number }
  | { kind: 'unsatisfiable'; size: number };

export function parseRangeHeader(rangeHeader: string | undefined, size: number): ParsedRange {
  if (size < 0) {
    return { kind: 'unsatisfiable', size };
  }
  if (!rangeHeader) {
    return { kind: 'full', start: 0, end: Math.max(size - 1, 0), contentLength: size };
  }

  if (rangeHeader.includes(',')) {
    return { kind: 'full', start: 0, end: Math.max(size - 1, 0), contentLength: size };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) {
    return { kind: 'unsatisfiable', size };
  }

  if (size === 0) {
    return { kind: 'unsatisfiable', size };
  }

  let start: number;
  let end: number;

  if (!match[1]) {
    const suffixLength = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { kind: 'unsatisfiable', size };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] ? parseInt(match[2], 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { kind: 'unsatisfiable', size };
  }

  end = Math.min(end, size - 1);
  return { kind: 'partial', start, end, contentLength: end - start + 1 };
}

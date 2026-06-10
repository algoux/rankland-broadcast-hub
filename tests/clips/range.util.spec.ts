import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from '@server/modules/clips/range.util';

describe('parseRangeHeader', () => {
  it('uses full response when no range header is present', () => {
    expect(parseRangeHeader(undefined, 10)).toEqual({ kind: 'full', start: 0, end: 9, contentLength: 10 });
  });

  it('parses bounded byte ranges', () => {
    expect(parseRangeHeader('bytes=2-5', 10)).toEqual({ kind: 'partial', start: 2, end: 5, contentLength: 4 });
  });

  it('parses suffix byte ranges', () => {
    expect(parseRangeHeader('bytes=-4', 10)).toEqual({ kind: 'partial', start: 6, end: 9, contentLength: 4 });
  });

  it('marks out-of-bounds ranges as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=20-30', 10)).toEqual({ kind: 'unsatisfiable', size: 10 });
  });

  it('ignores unsupported multi-range headers with a full response', () => {
    expect(parseRangeHeader('bytes=0-1,2-3', 10)).toEqual({ kind: 'full', start: 0, end: 9, contentLength: 10 });
  });
});

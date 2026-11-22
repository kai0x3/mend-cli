// mend — a single patch tool for the four edit formats AI models write.
//
// The contract is SPEC.md (version 1), and this file is all of it: argument
// handling, format detection, the three matching tiers, one reader and one
// applier per format, and the report. A patch is staged against an in-memory
// copy of the tree and reaches the disk only when every edit in it succeeds,
// so a run writes every change or none. Node 22, standard library alone.
//
// Run as `node main.ts [options] [PATCH]` with the working directory as the
// root of the tree. When the grader runs this file with MAKEFUN_ENV_URL set,
// the hand-over at the foot of the file passes the run to runner.ts instead,
// exactly as the kit's starter arranges.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A refusal of the whole run (exit 2): carries the one line to print. */
class Bail {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** A single edit's failure (exit 1): a SPEC code and the path it concerns. */
class Miss {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// Small text helpers ---------------------------------------------------------

const blank = (s: string): boolean => s.trim() === '';
/** The line with trailing spaces and tabs cut away. */
const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
/** The line with spaces and tabs cut from both ends. */
const trim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** The run of spaces and tabs a line starts with. */
const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * A patch's lines (SPEC section 3): the text split at \n, one trailing \r
 * removed from each piece, and no empty piece after a final \n.
 */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// Paths ----------------------------------------------------------------------

/** SPEC section 3: safe means no empty, "." or ".." segment, and no more. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function guardPath(p: string): void {
  if (!safePath(p)) throw new Miss('unsafe', p);
}

// Files as lines ---------------------------------------------------------------

/** A file taken apart: its own line break, its lines, its final-break flag. */
interface Doc {
  brk: string;
  lines: string[];
  tail: boolean;
}

function toDoc(text: string): Doc {
  if (text === '') return { brk: '\n', lines: [], tail: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) lines.pop();
  return { brk, lines, tail };
}

function fromDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.brk) + (d.tail ? d.brk : '');
}

// The staged tree ---------------------------------------------------------------

/**
 * The tree the edits work against. `staged` holds every path an edit has
 * settled — its new text, or null once it is gone. Anything an edit asks for
 * that is not staged is read from disk once and kept in `origin`, so the
 * closing report can compare the tree before the patch with the tree after.
 */
class Workspace {
  readonly staged = new Map<string, string | null>();
  private readonly origin = new Map<string, string | null>();
  /** The move edits that succeeded, in order, for the report's R lines. */
  readonly moves: Array<readonly [string, string]> = [];

  originOf(p: string): string | null {
    if (!this.origin.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origin.set(p, v);
    }
    return this.origin.get(p)!;
  }

  read(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.originOf(p);
  }

  write(p: string, v: string | null): void {
    this.staged.set(p, v);
  }
}

/** One edit of a patch: apply it to the workspace, or throw a Miss. */
type Edit = (ws: Workspace) => void;

/**
 * A created file's text (SPEC section 3): its lines joined with LF breaks
 * and ended by one, unless the edit's format says otherwise (`noBreak`).
 * A file of no lines is written empty.
 */
function createdText(lines: string[], noBreak = false): string {
  return lines.length === 0 ? '' : lines.join('\n') + (noBreak ? '' : '\n');
}

// Matching lines (SPEC section 5) ----------------------------------------------

function sameLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return trim(a) === trim(b);
}

/** Every start position at or after `from` where O matches F at this tier. */
function scanMatches(F: string[], O: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  outer: for (let i = from; i + O.length <= F.length; i += 1) {
    for (let j = 0; j < O.length; j += 1) {
      if (!sameLine(F[i + j]!, O[j]!, tier)) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

/**
 * The first tier (of the ones allowed) at which O occurs in F at or after
 * `from`, with that tier's occurrences; `keep` may narrow the occurrences.
 * Null when O occurs at no tier.
 */
function locate(
  F: string[],
  O: string[],
  strict: boolean,
  from: number,
  keep?: (pos: number) => boolean,
): { tier: number; hits: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    let hits = scanMatches(F, O, tier, from);
    if (keep !== undefined) hits = hits.filter(keep);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** One line of a replacement: a context line (its index into O) or a fresh line. */
interface NPart {
  text: string;
  ctx: number | null;
}

/**
 * What a match writes into the file. Context lines are the file's own matched
 * lines, never the patch's spelling of them. At tier 2 each fresh line is
 * re-indented: the patch's first-line indent P becomes the file's F, for any
 * line that is not blank and starts with P.
 */
function materialize(F: string[], O: string[], N: NPart[], at: number, tier: number): string[] {
  const out: string[] = [];
  const fLead = indentOf(F[at]!);
  const pLead = indentOf(O[0]!);
  for (const part of N) {
    if (part.ctx !== null) out.push(F[at + part.ctx]!);
    else if (tier === 2 && part.text.trim() !== '' && part.text.startsWith(pLead)) out.push(fLead + part.text.slice(pLead.length));
    else out.push(part.text);
  }
  return out;
}

// Format detection (SPEC section 4) ---------------------------------------------

function sniffFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => rtrim(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// JSON edits (SPEC section 9) ----------------------------------------------------

/**
 * One parsed JSON edit object as an Edit, or null when the object is not a
 * valid edit (a wrong command, or a missing or mistyped key) — the caller
 * turns that into the parse error of the object's line.
 */
function jsonToEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  // The file an edit works on, with the checks every such edit shares:
  // the path is safe, and the file is there.
  const present = (ws: Workspace): string => {
    guardPath(p);
    const t = ws.read(p);
    if (t === null) throw new Miss('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (ws) => {
      guardPath(p);
      if (ws.read(p) !== null) throw new Miss('exists', p);
      ws.write(p, text); // a create writes file_text byte for byte
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (ws) => {
      const before = present(ws);
      // In a CRLF file the text and both strings are read with \r\n as \n,
      // and the result is written back with \r\n.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = flat(before);
      const needle = flat(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new Miss('no-match', p);
      if (count > 1) throw new Miss('ambiguous', p);
      const at = text.indexOf(needle);
      const done = text.slice(0, at) + flat(newStr) + text.slice(at + needle.length);
      ws.write(p, crlf ? done.split('\n').join('\r\n') : done);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = splitPatch(o.new_str);
    return (ws) => {
      const doc = toDoc(present(ws));
      if (at < 0 || at > doc.lines.length) throw new Miss('no-match', p);
      doc.lines.splice(at, 0, ...add); // the file's final break stays as it was
      ws.write(p, fromDoc(doc));
    };
  }

  return null;
}

function readJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Bail('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    // Array form: any fault in it is the parse error of the array's line.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Bail(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonToEdit(item);
      if (e === null) throw new Bail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: one edit object a line, blank lines ignored.
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonToEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Bail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Unified diffs (SPEC section 6) ---------------------------------------------------

/** One line of a hunk body, tagged by the character that introduced it. */
interface RawLine {
  tag: 'ctx' | 'del' | 'add' | 'note';
  text: string;
  /** A context line that came from a wholly empty patch line. */
  bare: boolean;
}

interface HunkRec {
  /** The A of the hunk header; B, C and D are never used. */
  a: number;
  body: RawLine[];
}

interface SectionRec {
  gitOld: string | null;
  gitNew: string | null;
  /** The ---/+++ pair's paths: undefined until a pair is read, null for /dev/null. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  makesFile: boolean;
  dropsFile: boolean;
  hunks: HunkRec[];
}

/**
 * Whether a `\ No newline` note follows the body's last context or `+` line —
 * the note that takes the result's final line break away.
 */
function noteAfterLastNew(body: RawLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.tag === 'ctx' || b.tag === 'add') last = i;
  });
  return last >= 0 && body[last + 1]?.tag === 'note';
}

/** A ---/+++ path: up to the first tab, trimmed, /dev/null and a/ b/ handled. */
function stripHeaderPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: SectionRec[] = [];
  let sec: SectionRec | null = null;
  let inHeader = false;
  let i = 0;

  const openSection = (): SectionRec => {
    const s: SectionRec = {
      gitOld: null,
      gitNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      makesFile: false,
      dropsFile: false,
      hunks: [],
    };
    sections.push(s);
    sec = s;
    inHeader = true;
    return s;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*) b\/(.*)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      const s = openSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair inside the current section's header names its paths; anywhere
      // else it opens a section of its own.
      if (sec !== null && inHeader && sec.pairOld === undefined) {
        sec.pairOld = stripHeaderPath(line);
        sec.pairNew = stripHeaderPath(lines[i + 1]!);
      } else {
        const s = openSection();
        s.pairOld = stripHeaderPath(line);
        s.pairNew = stripHeaderPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (sec === null || m === null) throw new Bail(`error: parse ${i + 1}`);
      inHeader = false;
      const body: RawLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ tag: 'ctx', text: '', bare: true });
        else if (b.startsWith(' ')) body.push({ tag: 'ctx', text: b.slice(1), bare: false });
        else if (b.startsWith('-')) body.push({ tag: 'del', text: b.slice(1), bare: false });
        else if (b.startsWith('+')) body.push({ tag: 'add', text: b.slice(1), bare: false });
        else if (b.startsWith('\\')) body.push({ tag: 'note', text: b.slice(1), bare: false });
        else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.tag === 'ctx' && body[body.length - 1]!.bare) body.pop();
      sec.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (sec !== null && inHeader) {
      // A --- line in a header with no +++ after it is a parse error naming
      // the line after it; every other header line is read or ignored.
      if (line.startsWith('--- ')) throw new Bail(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.makesFile = true;
      else if (line.startsWith('deleted file mode')) sec.dropsFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedToEdit(s, strict));
}

function unifiedToEdit(sec: SectionRec, strict: boolean): Edit {
  // The pair wins, then the rename lines, then the diff --git paths.
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isDelete = sec.dropsFile || newPath === null;
  const isCreate = !isDelete && (sec.makesFile || oldPath === null);

  return (ws) => {
    if (oldPath !== null) guardPath(oldPath);
    if (newPath !== null) guardPath(newPath);

    if (isDelete) {
      const p = oldPath ?? '';
      if (ws.read(p) === null) throw new Miss('missing', p);
      ws.write(p, null); // a deletion's hunks are not read
      return;
    }

    if (isCreate) {
      const p = newPath ?? '';
      if (ws.read(p) !== null) throw new Miss('exists', p);
      const out: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.tag === 'add') {
            out.push(b.text);
            noBreak = h.body[idx + 1]?.tag === 'note';
          }
        });
      }
      ws.write(p, createdText(out, noBreak));
      return;
    }

    const from = oldPath ?? '';
    const to = newPath ?? '';
    const before = ws.read(from);
    if (before === null) throw new Miss('missing', from);
    const isMove = from !== to;
    if (isMove && ws.read(to) !== null) throw new Miss('exists', to);

    // The hunks apply in order, each to the result of the ones before it;
    // d is the running length change the header positions are corrected by.
    const doc = toDoc(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O: string[] = [];
      const N: NPart[] = [];
      for (const b of h.body) {
        if (b.tag === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.tag === 'del') {
          O.push(b.text);
        } else if (b.tag === 'add') {
          N.push({ text: b.text, ctx: null });
        }
      }
      if (O.length === 0) {
        // Nothing to find: N goes in after the first A + d lines.
        const at = Math.max(0, Math.min(h.a + d, doc.lines.length));
        const atEnd = at === doc.lines.length;
        doc.lines.splice(at, 0, ...N.map((n) => n.text));
        if (atEnd) doc.tail = !noteAfterLastNew(h.body);
      } else {
        const found = locate(doc.lines, O, strict, 0);
        if (found === null) throw new Miss('no-match', from);
        // Of the occurrences at the tier, the one nearest to A - 1 + d;
        // of two equally near, the earlier.
        const target = h.a - 1 + d;
        let at = found.hits[0]!;
        for (const hit of found.hits) {
          if (Math.abs(hit - target) < Math.abs(at - target)) at = hit;
        }
        const touchesEnd = at + O.length === doc.lines.length;
        const written = materialize(doc.lines, O, N, at, found.tier);
        doc.lines.splice(at, O.length, ...written);
        if (touchesEnd) doc.tail = !noteAfterLastNew(h.body);
      }
      d += N.length - O.length;
    }
    ws.write(to, fromDoc(doc));
    if (isMove) {
      ws.write(from, null);
      ws.moves.push([from, to]);
    }
  };
}

// SEARCH/REPLACE blocks (SPEC section 7) -------------------------------------------

interface BlockRec {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: BlockRec[] = [];
  let prevEnd = -1; // the previous block's REPLACE line; paths are sought after it
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrim(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let mid = i + 1;
    while (mid < lines.length && rtrim(lines[mid]!) !== '=======') mid += 1;
    if (mid >= lines.length) throw new Bail(`error: parse ${searchAt + 1}`);
    let end = mid + 1;
    while (end < lines.length && rtrim(lines[end]!) !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new Bail(`error: parse ${searchAt + 1}`);

    // The block's path is the nearest line before its SEARCH line — after the
    // previous block's end — that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let m = searchAt - 1; m > prevEnd; m -= 1) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath; // or the previous block's path
    if (path === null) throw new Bail(`error: parse ${searchAt + 1}`);

    blocks.push({ path, oldLines: lines.slice(searchAt + 1, mid), newLines: lines.slice(mid + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => searchReplaceToEdit(b, strict));
}

function searchReplaceToEdit(b: BlockRec, strict: boolean): Edit {
  return (ws) => {
    guardPath(b.path);
    if (b.oldLines.length === 0) {
      // No old lines: the block creates the file from its new lines.
      if (ws.read(b.path) !== null) throw new Miss('exists', b.path);
      ws.write(b.path, createdText(b.newLines));
      return;
    }
    const before = ws.read(b.path);
    if (before === null) throw new Miss('missing', b.path);
    const doc = toDoc(before);
    const found = locate(doc.lines, b.oldLines, strict, 0);
    if (found === null) throw new Miss('no-match', b.path);
    if (found.hits.length > 1) throw new Miss('ambiguous', b.path);
    const at = found.hits[0]!;
    const N: NPart[] = b.newLines.map((text) => ({ text, ctx: null }));
    const written = materialize(doc.lines, b.oldLines, N, at, found.tier);
    doc.lines.splice(at, b.oldLines.length, ...written);
    ws.write(b.path, fromDoc(doc));
  };
}

// V4A patches (SPEC section 8) ------------------------------------------------------

interface ChunkLine {
  tag: 'ctx' | 'del' | 'add';
  text: string;
}

interface ChunkRec {
  anchor: string | null;
  eof: boolean;
  body: ChunkLine[];
}

interface V4aRec {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: ChunkRec[];
}

const V4A_HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '] as const;

function readV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Bail(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Bail(`error: parse ${lines.length + 1}`);

  const sections: V4aRec[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = V4A_HEADS.find((h) => line.startsWith(h));
    if (head === undefined) throw new Bail(`error: parse ${i + 1}`);
    const kind = head === '*** Add File: ' ? 'add' : head === '*** Delete File: ' ? 'delete' : 'update';
    const path = line.slice(head.length).trim();
    const headLine = i + 1;
    i += 1;
    // The section's own lines, up to the next section head, with the blank
    // lines at its end left out of it.
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last && !V4A_HEADS.some((h) => lines[i]!.startsWith(h))) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Bail(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, addLines, moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Bail(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, addLines: [], moveTo: null, chunks: [] });
    } else {
      sections.push(readV4aUpdate(path, headLine, raw));
    }
  }
  return sections.map((s) => v4aToEdit(s, strict));
}

function readV4aUpdate(path: string, headLine: number, raw: Array<{ text: string; no: number }>): V4aRec {
  let moveTo: string | null = null;
  const chunks: ChunkRec[] = [];
  let cur: ChunkRec | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    if (r.text.startsWith('@@')) {
      const anchor = r.text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (r.text === '*** End of File') {
      if (cur === null) throw new Bail(`error: parse ${r.no}`);
      cur.eof = true;
      cur = null; // the chunk is closed; a body line after it has no chunk
    } else if (r.text.startsWith(' ') || r.text.startsWith('-') || r.text.startsWith('+') || r.text === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Bail(`error: parse ${r.no}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      if (r.text.startsWith(' ')) cur.body.push({ tag: 'ctx', text: r.text.slice(1) });
      else if (r.text.startsWith('-')) cur.body.push({ tag: 'del', text: r.text.slice(1) });
      else if (r.text.startsWith('+')) cur.body.push({ tag: 'add', text: r.text.slice(1) });
      else cur.body.push({ tag: 'ctx', text: '' });
    } else {
      throw new Bail(`error: parse ${r.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Bail(`error: parse ${headLine}`);
  return { kind: 'update', path, addLines: [], moveTo, chunks };
}

function v4aToEdit(sec: V4aRec, strict: boolean): Edit {
  return (ws) => {
    guardPath(sec.path);
    if (sec.kind === 'add') {
      if (ws.read(sec.path) !== null) throw new Miss('exists', sec.path);
      ws.write(sec.path, createdText(sec.addLines));
      return;
    }
    if (sec.kind === 'delete') {
      if (ws.read(sec.path) === null) throw new Miss('missing', sec.path);
      ws.write(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) guardPath(sec.moveTo);
    const before = ws.read(sec.path);
    if (before === null) throw new Miss('missing', sec.path);
    if (sec.moveTo !== null && ws.read(sec.moveTo) !== null) throw new Miss('exists', sec.moveTo);

    // The chunks apply in order behind a cursor that starts at line 0 and
    // moves to just after the lines each chunk writes.
    const doc = toDoc(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        // The anchor is one line, found at or after the cursor at the first
        // tier where a line equals it; the cursor moves past it.
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < doc.lines.length; k += 1) {
            if (sameLine(doc.lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Miss('no-match', sec.path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NPart[] = [];
      for (const b of chunk.body) {
        if (b.tag === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.tag === 'del') {
          O.push(b.text);
        } else {
          N.push({ text: b.text, ctx: null });
        }
      }
      if (O.length === 0) {
        const at = chunk.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
        doc.lines.splice(at, 0, ...N.map((n) => n.text));
        cursor = at + N.length;
      } else {
        // An end-of-file chunk takes only an occurrence that ends at the
        // file's last line.
        const found = locate(doc.lines, O, strict, cursor, chunk.eof ? (pos) => pos + O.length === doc.lines.length : undefined);
        if (found === null) throw new Miss('no-match', sec.path);
        const at = found.hits[0]!;
        const written = materialize(doc.lines, O, N, at, found.tier);
        doc.lines.splice(at, O.length, ...written);
        cursor = at + written.length;
      }
    }
    const result = fromDoc(doc);
    if (sec.moveTo !== null) {
      ws.write(sec.moveTo, result);
      ws.write(sec.path, null);
      ws.moves.push([sec.path, sec.moveTo]);
    } else {
      ws.write(sec.path, result);
    }
  };
}

// The report and the run (SPEC sections 1, 2 and 10) ---------------------------------

const say = (s: string): void => {
  writeSync(1, `${s}\n`);
};

/** UTF-8 byte order, the order the report's lines sort by. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The exit-0 report: one line per path whose state changed, sorted by path
 * in byte order. A move edit whose old path is gone and whose new path holds
 * the file collapses its D and A lines into one R line, sorted by the new
 * path; a file whose bytes did not change is not listed at all.
 */
function reportLines(ws: Workspace): string[] {
  const changed = new Set<string>();
  for (const [p, after] of ws.staged) {
    if (after !== ws.originOf(p)) changed.add(p);
  }
  const lines: Array<{ key: string; text: string }> = [];
  const goneByMove = new Set<string>();
  const bornByMove = new Set<string>();
  for (const [from, to] of ws.moves) {
    const realMove =
      ws.originOf(from) !== null &&
      ws.originOf(to) === null &&
      ws.staged.get(from) === null &&
      ws.staged.get(to) !== undefined &&
      ws.staged.get(to) !== null;
    if (realMove && changed.has(from) && changed.has(to)) {
      lines.push({ key: to, text: `R ${from} -> ${to}` });
      goneByMove.add(from);
      bornByMove.add(to);
    }
  }
  for (const p of changed) {
    if (goneByMove.has(p) || bornByMove.has(p)) continue;
    lines.push({ key: p, text: ws.staged.get(p) === null ? `D ${p}` : ws.originOf(p) === null ? `A ${p}` : `M ${p}` });
  }
  return lines
    .sort((x, y) => byBytes(x.key, y.key))
    .map((l) => l.text);
}

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function run(argv: string[]): number {
  try {
    // Options and PATCH may come in any order; `--` ends the options.
    let strict = false;
    let checkOnly = false;
    let named: string | null = null;
    const positional: string[] = [];
    let optionsDone = false;
    for (const arg of argv) {
      if (!optionsDone && arg === '--') {
        optionsDone = true;
      } else if (!optionsDone && arg === '--strict') {
        if (strict) throw new Bail('error: usage');
        strict = true;
      } else if (!optionsDone && arg === '--check') {
        if (checkOnly) throw new Bail('error: usage');
        checkOnly = true;
      } else if (!optionsDone && arg.startsWith('--format=')) {
        if (named !== null) throw new Bail('error: usage');
        named = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(named)) throw new Bail('error: usage');
      } else if (!optionsDone && arg.startsWith('-') && arg !== '-') {
        throw new Bail('error: usage');
      } else {
        positional.push(arg);
      }
    }
    if (positional.length > 1) throw new Bail('error: usage');

    // The patch text: from the PATCH file, or from standard input when PATCH
    // is absent or `-`. A file that cannot be read is error: no-patch.
    let patch: string | null = null;
    if (positional.length === 1 && positional[0] !== '-') {
      try {
        patch = readFileSync(positional[0]!, 'utf8');
      } catch {
        patch = null;
      }
      if (patch === null) throw new Bail('error: no-patch');
    } else if (process.stdin.isTTY !== true) {
      try {
        patch = readFileSync(0, 'utf8');
      } catch {
        patch = null;
      }
      if (patch === null) throw new Bail('error: no-patch');
    } else {
      throw new Bail('error: no-patch');
    }

    const lines = splitPatch(patch);
    const format = named !== null && named !== 'auto' ? named : sniffFormat(lines);
    if (format === null) throw new Bail('error: format');
    const edits =
      format === 'json'
        ? readJsonEdits(patch, lines)
        : format === 'unified'
          ? readUnified(lines, strict)
          : format === 'search-replace'
            ? readSearchReplace(lines, strict)
            : readV4a(lines, strict);
    if (edits.length === 0) throw new Bail('error: parse 1');

    // The edits apply in the patch's order, each to the tree as the earlier
    // ones left it. A failed edit is rolled back and changes nothing; the
    // edits after it still run, so every failure is reported.
    const ws = new Workspace();
    const failures: Miss[] = [];
    for (const edit of edits) {
      const keep = new Map(ws.staged);
      const moveCount = ws.moves.length;
      try {
        edit(ws);
      } catch (e) {
        if (!(e instanceof Miss)) throw e;
        ws.staged.clear();
        for (const [k, v] of keep) ws.staged.set(k, v);
        ws.moves.length = moveCount;
        failures.push(e);
      }
    }
    if (failures.length > 0) {
      for (const f of failures) say(`error: ${f.code} ${f.path}`);
      say(`failed: ${failures.length} of ${edits.length} edits`);
      return 1;
    }

    // None failed: every change is written (with --check, none is), and the
    // report is printed.
    const out = reportLines(ws);
    if (!checkOnly) {
      for (const [p, after] of ws.staged) {
        if (after === ws.originOf(p)) continue;
        if (after === null) {
          rmSync(p, { force: true });
        } else {
          mkdirSync(dirname(p) === '' ? '.' : dirname(p), { recursive: true });
          writeFileSync(p, after);
        }
      }
    }
    for (const l of out) say(l);
    say(out.length === 1 ? 'ok: 1 file' : `ok: ${out.length} files`);
    return 0;
  } catch (e) {
    if (e instanceof Bail) {
      say(e.line);
      return 2;
    }
    throw e;
  }
}

// The trial hand-over, kept as the kit has it: with MAKEFUN_ENV_URL set this
// process is the runner the grader talks to; without it, it is the CLI.
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  process.exitCode = run(process.argv.slice(2));
}

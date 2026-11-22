// mend — one patch tool for every AI edit format.
//
// AI models hand back edits in four shapes: unified diffs, SEARCH/REPLACE
// blocks, V4A patches and JSON edit lists. mend reads any of them, works out
// where each edit lands (three matching tiers, from exact down to
// indent-blind), and then rewrites the tree — every change or none of them.
// The contract it implements is SPEC.md, which ships beside this file.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` in the
// root of the tree being patched. When MAKEFUN_ENV_URL is set the program
// instead hands itself over to the kit's trial runner (runner.ts).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

/* ------------------------------------------------------------------ */
/* Text plumbing                                                       */
/* ------------------------------------------------------------------ */

type Brk = '\n' | '\r\n';

/** The line break a text uses: CRLF when its first line feed follows a CR. */
function breakOf(text: string): Brk {
  const at = text.indexOf('\n');
  return at > 0 && text.charAt(at - 1) === '\r' ? '\r\n' : '\n';
}

/** A file held as lines: the rows, its own break, and whether it ends in one. */
interface Doc {
  rows: string[];
  brk: Brk;
  tail: boolean;
}

function toDoc(text: string): Doc {
  const brk = breakOf(text);
  if (text === '') return { rows: [], brk, tail: false };
  const parts = text.split(brk);
  let tail = false;
  if (parts[parts.length - 1] === '') {
    tail = true;
    parts.pop();
  }
  return { rows: parts, brk, tail };
}

function toText(doc: Doc): string {
  if (doc.rows.length === 0) return '';
  return doc.rows.join(doc.brk) + (doc.tail ? doc.brk : '');
}

/** A patch's lines: split at \n, one trailing \r off each, no phantom last line. */
function patchRows(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A path is safe when relative, slash-joined and free of wild segments. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/* ------------------------------------------------------------------ */
/* The tree: an overlay so a failed run writes nothing                 */
/* ------------------------------------------------------------------ */

interface Fail {
  code: string;
  path: string;
}

type EditFn = (tree: Tree) => Fail | null;

class Tree {
  private before = new Map<string, string | null>();
  private after = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];

  /** Current bytes of a path, or null when it does not exist. */
  read(path: string): string | null {
    const hit = this.after.get(path);
    if (hit !== undefined) return hit;
    let text: string | null;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    this.before.set(path, text);
    this.after.set(path, text);
    return text;
  }

  write(path: string, text: string | null): void {
    this.read(path);
    this.after.set(path, text);
  }

  touched(): string[] {
    return [...this.after.keys()];
  }

  was(path: string): string | null {
    return this.before.get(path) ?? null;
  }

  now(path: string): string | null {
    return this.after.get(path) ?? null;
  }

  /** Push every changed path to disk; called only when nothing failed. */
  flush(): void {
    for (const [p, v] of this.after) {
      if (this.before.get(p) === v) continue;
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Matching: three tiers, first tier with an occurrence wins           */
/* ------------------------------------------------------------------ */

type Tier = 0 | 1 | 2;

function rowEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every start position (from `from`) where old's rows match at this tier. */
function occurrences(rows: string[], old: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + old.length <= rows.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!rowEq(rows[i + j], old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersOf(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which old occurs at or after `from`, with its positions. */
function locate(
  rows: string[],
  old: string[],
  strict: boolean,
  from: number,
): { tier: Tier; at: number[] } | null {
  for (const t of tiersOf(strict)) {
    const at = occurrences(rows, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: patch text, or a context line (index into old). */
interface Piece {
  text: string;
  ctx: number; // >= 0: this piece is old[ctx], written as the file's own line
  noEol: boolean;
}

/**
 * The replacement pieces of a hunk or chunk body, in body order: its context
 * and added lines, each context line carrying its own index within the old
 * lines (deleted lines count — they sit between context lines there).
 */
function piecesOf(entries: UEntry[]): Piece[] {
  const out: Piece[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.kind === 'del') {
      oi += 1;
    } else if (e.kind === 'ctx') {
      out.push({ text: e.text, ctx: oi, noEol: e.noEol });
      oi += 1;
    } else {
      out.push({ text: e.text, ctx: -1, noEol: e.noEol });
    }
  }
  return out;
}

/**
 * Render a replacement at a match: context pieces become the file's matched
 * lines; at tier 2 the rest are re-indented from the patch's first-line
 * indent onto the file's.
 */
function render(rows: string[], pos: number, old: string[], pieces: Piece[], tier: Tier): string[] {
  const fileLead = leadOf(rows[pos]);
  const patchLead = leadOf(old[0]);
  return pieces.map((pc) => {
    if (pc.ctx >= 0) return rows[pos + pc.ctx];
    if (tier === 2 && !isBlank(pc.text) && pc.text.startsWith(patchLead)) {
      return fileLead + pc.text.slice(patchLead.length);
    }
    return pc.text;
  });
}

/* ------------------------------------------------------------------ */
/* Parse faults                                                        */
/* ------------------------------------------------------------------ */

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/* ------------------------------------------------------------------ */
/* Unified diffs                                                       */
/* ------------------------------------------------------------------ */

interface UEntry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noEol: boolean;
  bare: boolean; // came from a truly empty patch line (a context line)
}

interface UHunk {
  a: number;
  entries: UEntry[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a --- or +++ line names: up to a tab, trimmed, prefix off. */
function pathToken(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(rows: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const n = rows.length;
  while (i < n) {
    const line = rows[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      cur = { gitOld: m[1], gitNew: m[2], newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = i + 1 < n ? rows[i + 1] : undefined;
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw new ParseFault(i + 2);
      const o = pathToken(line);
      const w = pathToken(nxt);
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined && cur.gitOld !== undefined) {
        cur.pairOld = o;
        cur.pairNew = w;
      } else {
        cur = { pairOld: o, pairNew: w, newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      const hunk: UHunk = { a: parseInt(m[1], 10), entries: [] };
      i += 1;
      while (i < n) {
        const b = rows[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && rows[i + 1].startsWith('+++ ')) break;
        const c = b.charAt(0);
        if (c === ' ') hunk.entries.push({ kind: 'ctx', text: b.slice(1), noEol: false, bare: false });
        else if (c === '-') hunk.entries.push({ kind: 'del', text: b.slice(1), noEol: false, bare: false });
        else if (c === '+') hunk.entries.push({ kind: 'add', text: b.slice(1), noEol: false, bare: false });
        else if (c === '\\') {
          const prev = hunk.entries[hunk.entries.length - 1];
          if (prev) prev.noEol = true;
        } else if (b === '') hunk.entries.push({ kind: 'ctx', text: '', noEol: false, bare: true });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1];
        if (last.kind === 'ctx' && last.bare) hunk.entries.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply one section's hunks to a doc; returns a failure code or null. */
function applyHunks(doc: Doc, hunks: UHunk[], strict: boolean): string | null {
  let d = 0; // lines gained over the hunks of this section applied so far
  for (const h of hunks) {
    const oldTexts = h.entries.filter((e) => e.kind !== 'add').map((e) => e.text);
    const pieces = piecesOf(h.entries);
    if (oldTexts.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, doc.rows.length));
      const atEnd = at === doc.rows.length;
      const added = pieces.map((p) => p.text);
      doc.rows.splice(at, 0, ...added);
      if (atEnd && added.length > 0) doc.tail = !pieces[pieces.length - 1].noEol;
      d += added.length;
      continue;
    }
    const loc = locate(doc.rows, oldTexts, strict, 0);
    if (!loc) return 'no-match';
    const target = h.a - 1 + d;
    let pos = loc.at[0];
    let best = Math.abs(pos - target);
    for (const cand of loc.at) {
      const dist = Math.abs(cand - target);
      if (dist < best) {
        best = dist;
        pos = cand;
      }
    }
    const rendered = render(doc.rows, pos, oldTexts, pieces, loc.tier);
    const touchesEnd = pos + oldTexts.length === doc.rows.length;
    doc.rows.splice(pos, oldTexts.length, ...rendered);
    if (touchesEnd) doc.tail = pieces.length > 0 ? !pieces[pieces.length - 1].noEol : true;
    d += pieces.length - oldTexts.length;
  }
  return null;
}

function unifiedEdit(sec: USection, strict: boolean): EditFn {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renFrom !== undefined ? sec.renFrom : sec.gitOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renTo !== undefined ? sec.renTo : sec.gitNew;
  const isCreate = sec.newFile || oldP === null;
  const isDelete = sec.delFile || newP === null;
  return (tree) => {
    if (isCreate) {
      const target = newP ?? oldP;
      if (target === undefined || target === null) return { code: 'missing', path: '' };
      if (!safePath(target)) return { code: 'unsafe', path: target };
      if (tree.read(target) !== null) return { code: 'exists', path: target };
      const out: string[] = [];
      let lastAdd: UEntry | null = null;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'add') {
            out.push(e.text);
            lastAdd = e;
          }
        }
      }
      const tail = out.length > 0 && !(lastAdd !== null && lastAdd.noEol);
      tree.write(target, toText({ rows: out, brk: '\n', tail }));
      return null;
    }
    if (isDelete) {
      const target = oldP ?? newP;
      if (target === undefined || target === null) return { code: 'missing', path: '' };
      if (!safePath(target)) return { code: 'unsafe', path: target };
      if (tree.read(target) === null) return { code: 'missing', path: target };
      tree.write(target, null);
      return null;
    }
    const from = oldP as string;
    const to = newP as string;
    if (!safePath(from)) return { code: 'unsafe', path: from };
    if (to !== from && !safePath(to)) return { code: 'unsafe', path: to };
    const text = tree.read(from);
    if (text === null) return { code: 'missing', path: from };
    if (to !== from && tree.read(to) !== null) return { code: 'exists', path: to };
    const doc = toDoc(text);
    const bad = applyHunks(doc, sec.hunks, strict);
    if (bad !== null) return { code: bad, path: from };
    if (to !== from) {
      tree.write(to, toText(doc));
      tree.write(from, null);
      tree.moves.push({ from, to });
    } else {
      tree.write(from, toText(doc));
    }
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks                                               */
/* ------------------------------------------------------------------ */

interface SBlock {
  path: string;
  oldRows: string[];
  newRows: string[];
}

function parseSearchReplace(rows: string[]): SBlock[] {
  const blocks: SBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < rows.length) {
    if (stripTrail(rows[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const cand = rows[j];
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFault(searchAt + 1);
    }
    let eq = -1;
    for (let k = searchAt + 1; k < rows.length; k++) {
      const t = stripTrail(rows[k]);
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new ParseFault(searchAt + 1);
    let rep = -1;
    for (let k = eq + 1; k < rows.length; k++) {
      if (stripTrail(rows[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(searchAt + 1);
    blocks.push({ path, oldRows: rows.slice(searchAt + 1, eq), newRows: rows.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdit(b: SBlock, strict: boolean): EditFn {
  return (tree) => {
    if (!safePath(b.path)) return { code: 'unsafe', path: b.path };
    if (b.oldRows.length === 0) {
      if (tree.read(b.path) !== null) return { code: 'exists', path: b.path };
      tree.write(b.path, toText({ rows: [...b.newRows], brk: '\n', tail: b.newRows.length > 0 }));
      return null;
    }
    const text = tree.read(b.path);
    if (text === null) return { code: 'missing', path: b.path };
    const doc = toDoc(text);
    const loc = locate(doc.rows, b.oldRows, strict, 0);
    if (!loc) return { code: 'no-match', path: b.path };
    if (loc.at.length > 1) return { code: 'ambiguous', path: b.path };
    const pos = loc.at[0];
    const pieces: Piece[] = b.newRows.map((t) => ({ text: t, ctx: -1, noEol: false }));
    const rendered = render(doc.rows, pos, b.oldRows, pieces, loc.tier);
    doc.rows.splice(pos, b.oldRows.length, ...rendered);
    tree.write(b.path, toText(doc));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches                                                         */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: UEntry[];
}

type VSection =
  | { kind: 'add'; path: string; rows: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo: string | null; chunks: VChunk[] };

function parseV4a(rows: string[]): VSection[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!isBlank(rows[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (rows[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isBlank(rows[i])) {
      last = i;
      break;
    }
  }
  if (rows[last].trim() !== '*** End Patch') throw new ParseFault(rows.length + 1);

  const isHead = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = rows[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (!isHead(line)) throw new ParseFault(i + 1);
    const headAt = i;
    const body: { text: string; at: number }[] = [];
    let j = i + 1;
    while (j < last && !isHead(rows[j])) {
      body.push({ text: rows[j], at: j });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (body.length > 0 && isBlank(body[body.length - 1].text)) body.pop();

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const out: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) out.push(b.text.slice(1));
        else if (b.text === '') out.push('');
        else throw new ParseFault(b.at + 1);
      }
      sections.push({ kind: 'add', path, rows: out });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (body.length > 0) throw new ParseFault(body[0].at + 1);
      sections.push({ kind: 'del', path });
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0].text.startsWith('*** Move to: ')) {
        moveTo = body[0].text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (; k < body.length; k++) {
        const b = body[k];
        const t = b.text;
        if (t === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, entries: [] };
            chunks.push(chunk);
          } else {
            chunk.eof = true;
          }
          chunk = null;
          continue;
        }
        if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, entries: [] };
          chunks.push(chunk);
          continue;
        }
        const c = t.charAt(0);
        if (c === ' ' || c === '-' || c === '+' || t === '') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, entries: [] };
            chunks.push(chunk);
          }
          if (t === '') chunk.entries.push({ kind: 'ctx', text: '', noEol: false, bare: true });
          else
            chunk.entries.push({
              kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
              text: t.slice(1),
              noEol: false,
              bare: false,
            });
          continue;
        }
        throw new ParseFault(b.at + 1);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(headAt + 1);
      sections.push({ kind: 'upd', path, moveTo, chunks });
    }
    i = j;
  }
  return sections;
}

/** The first line at or after `from` equal to the anchor, tier by tier. */
function findAnchor(rows: string[], anchor: string, strict: boolean, from: number): number {
  for (const t of tiersOf(strict)) {
    for (let i = from; i < rows.length; i++) {
      if (rowEq(rows[i], anchor, t)) return i;
    }
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean): EditFn {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safePath(sec.path)) return { code: 'unsafe', path: sec.path };
      if (tree.read(sec.path) !== null) return { code: 'exists', path: sec.path };
      tree.write(sec.path, toText({ rows: [...sec.rows], brk: '\n', tail: sec.rows.length > 0 }));
      return null;
    }
    if (sec.kind === 'del') {
      if (!safePath(sec.path)) return { code: 'unsafe', path: sec.path };
      if (tree.read(sec.path) === null) return { code: 'missing', path: sec.path };
      tree.write(sec.path, null);
      return null;
    }
    if (!safePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (sec.moveTo !== null && !safePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
    const text = tree.read(sec.path);
    if (text === null) return { code: 'missing', path: sec.path };
    if (sec.moveTo !== null && tree.read(sec.moveTo) !== null) return { code: 'exists', path: sec.moveTo };
    const doc = toDoc(text);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const hit = findAnchor(doc.rows, ch.anchor, strict, cursor);
        if (hit < 0) return { code: 'no-match', path: sec.path };
        cursor = hit + 1;
      }
      const oldTexts = ch.entries.filter((e) => e.kind !== 'add').map((e) => e.text);
      const pieces = piecesOf(ch.entries);
      if (oldTexts.length === 0) {
        const at = ch.eof ? doc.rows.length : Math.min(cursor, doc.rows.length);
        const added = pieces.map((p) => p.text);
        doc.rows.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      let found: { tier: Tier; pos: number } | null = null;
      for (const t of tiersOf(strict)) {
        let occ = occurrences(doc.rows, oldTexts, t, cursor);
        if (ch.eof) occ = occ.filter((p) => p + oldTexts.length === doc.rows.length);
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0] };
          break;
        }
      }
      if (found === null) return { code: 'no-match', path: sec.path };
      const rendered = render(doc.rows, found.pos, oldTexts, pieces, found.tier);
      doc.rows.splice(found.pos, oldTexts.length, ...rendered);
      cursor = found.pos + rendered.length;
    }
    if (sec.moveTo !== null) {
      tree.write(sec.moveTo, toText(doc));
      tree.write(sec.path, null);
      tree.moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.write(sec.path, toText(doc));
    }
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits                                                          */
/* ------------------------------------------------------------------ */

type JEdit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; line: number; text: string };

/** A parsed JSON value as an edit, or null when it is not a valid one. */
function asEdit(v: unknown): JEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'create', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'insert', path: o.path, line: o.insert_line, text: o.new_str };
  }
  return null;
}

function parseJson(rows: string[], text: string): JEdit[] {
  const edits: JEdit[] = [];
  if (text.trimStart().startsWith('[')) {
    // Array form: every fault is charged to the line where the array starts.
    const at = text.indexOf('[');
    let lineNo = 1;
    for (let i = 0; i < at; i++) if (text[i] === '\n') lineNo += 1;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(lineNo);
    }
    if (!Array.isArray(value)) throw new ParseFault(lineNo);
    for (const item of value) {
      const e = asEdit(item);
      if (e === null) throw new ParseFault(lineNo);
      edits.push(e);
    }
    return edits;
  }
  rows.forEach((row, idx) => {
    if (isBlank(row)) return;
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch {
      throw new ParseFault(idx + 1);
    }
    const e = asEdit(value);
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

/** The lines an insert's new_str carries: split as a patch text is split. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function jsonEdit(e: JEdit): EditFn {
  return (tree) => {
    if (!safePath(e.path)) return { code: 'unsafe', path: e.path };
    if (e.kind === 'create') {
      if (tree.read(e.path) !== null) return { code: 'exists', path: e.path };
      tree.write(e.path, e.text);
      return null;
    }
    const text = tree.read(e.path);
    if (text === null) return { code: 'missing', path: e.path };
    if (e.kind === 'str_replace') {
      const crlf = breakOf(text) === '\r\n';
      const flat = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = flat(text);
      const oldS = flat(e.oldStr);
      const newS = flat(e.newStr);
      let count = 0;
      let at = -1;
      for (let i = 0; i + oldS.length <= hay.length; i++) {
        if (hay.startsWith(oldS, i)) {
          count += 1;
          at = i;
          if (count > 1) break;
        }
      }
      if (count === 0) return { code: 'no-match', path: e.path };
      if (count > 1) return { code: 'ambiguous', path: e.path };
      let out = hay.slice(0, at) + newS + hay.slice(at + oldS.length);
      if (crlf) out = out.split('\n').join('\r\n');
      tree.write(e.path, out);
      return null;
    }
    const doc = toDoc(text);
    if (e.line < 0 || e.line > doc.rows.length) return { code: 'no-match', path: e.path };
    doc.rows.splice(e.line, 0, ...splitNewStr(e.text));
    tree.write(e.path, toText(doc));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* Format detection                                                    */
/* ------------------------------------------------------------------ */

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';

function detect(rows: string[]): Format | null {
  let firstNonBlank: string | null = null;
  for (const r of rows) {
    if (!isBlank(r)) {
      firstNonBlank = r;
      break;
    }
  }
  if (firstNonBlank !== null && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== null) {
    const c = firstNonBlank.trimStart().charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const r of rows) {
    if (stripTrail(r) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].startsWith('diff --git ')) return 'unified';
    if (rows[i].startsWith('--- ') && i + 1 < rows.length && rows[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/**
 * Whether a recorded move shows in the report as an R line: the old path
 * existed before the patch and is gone now, the new one the reverse.
 */
function moveCounts(tree: Tree, mv: { from: string; to: string }): boolean {
  return (
    tree.was(mv.from) !== null && tree.now(mv.from) === null && tree.was(mv.to) === null && tree.now(mv.to) !== null
  );
}

/** The A/D/M/R lines for everything the run changed, in path byte order. */
function reportLines(tree: Tree): string[] {
  const out: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    if (moveCounts(tree, mv)) {
      out.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      covered.add(mv.from);
      covered.add(mv.to);
    }
  }
  for (const p of tree.touched()) {
    if (covered.has(p)) continue;
    const was = tree.was(p);
    const now = tree.now(p);
    if (was === now) continue;
    if (was === null) out.push({ key: p, line: `A ${p}` });
    else if (now === null) out.push({ key: p, line: `D ${p}` });
    else out.push({ key: p, line: `M ${p}` });
  }
  out.sort((x, y) => byteCompare(x.key, y.key));
  return out.map((o) => o.line);
}

/* ------------------------------------------------------------------ */
/* The command line                                                    */
/* ------------------------------------------------------------------ */

function emit(lines: string[]): void {
  process.stdout.write(lines.map((l) => l + '\n').join(''));
}

function fail2(line: string): number {
  emit([line]);
  return 2;
}

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function runCli(argv: string[]): number {
  let format = 'auto';
  let checkOnly = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let ended = false;
  for (const arg of argv) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && (arg === '--check' || arg === '--strict' || arg.startsWith('--format='))) {
      const name = arg.startsWith('--format=') ? '--format' : arg;
      if (seen.has(name)) return fail2('error: usage');
      seen.add(name);
      if (arg === '--check') checkOnly = true;
      else if (arg === '--strict') strict = true;
      else {
        const v = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return fail2('error: usage');
        format = v;
      }
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') return fail2('error: usage');
    positional.push(arg);
  }
  if (positional.length > 1) return fail2('error: usage');

  let patchText: string;
  const src = positional[0];
  if (src === undefined || src === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(src, 'utf8');
    } catch {
      return fail2('error: no-patch');
    }
  }

  const rows = patchRows(patchText);
  let fmt: Format;
  if (format === 'auto') {
    const found = detect(rows);
    if (found === null) return fail2('error: format');
    fmt = found;
  } else {
    fmt = format as Format;
  }

  let edits: EditFn[];
  try {
    if (fmt === 'unified') edits = parseUnified(rows).map((s) => unifiedEdit(s, strict));
    else if (fmt === 'search-replace') edits = parseSearchReplace(rows).map((b) => searchReplaceEdit(b, strict));
    else if (fmt === 'v4a') edits = parseV4a(rows).map((s) => v4aEdit(s, strict));
    else edits = parseJson(rows, patchText).map((e) => jsonEdit(e));
    if (edits.length === 0) throw new ParseFault(1);
  } catch (err) {
    if (err instanceof ParseFault) return fail2(`error: parse ${err.line}`);
    throw err;
  }

  const tree = new Tree();
  const failures: Fail[] = [];
  for (const edit of edits) {
    const f = edit(tree);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    emit([...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`]);
    return 1;
  }

  const lines = reportLines(tree);
  if (!checkOnly) tree.flush();
  const n = lines.length;
  emit([...lines, n === 1 ? 'ok: 1 file' : `ok: ${n} files`]);
  return 0;
}

/* ------------------------------------------------------------------ */

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
} else {
  process.exitCode = runCli(process.argv.slice(2));
}

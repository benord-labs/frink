import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAttachedFilePath } from '../../../../shared/lib/mentions/parse-mention';
import {
  PASTED_FILE_MAX_BYTES,
  PASTED_FILE_TOO_LARGE,
} from '../../../../shared/pasted-file-limits';
import {
  attachedFileNote,
  copyIntoPasted,
  rehomePastedMentions,
  safeAttachmentName,
  writePastedText,
} from '.';

const subChatId = 'mq7zk90vzeoypywd';

describe('pasted files', () => {
  let source: string;
  let userData: string;

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'frink-pasted-files-'));
    source = mkdtempSync(join(tmpdir(), 'frink-pasted-source-'));
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  it('copies an attached file into the sub-chat pasted folder under a unique name', async () => {
    const pdf = join(source, 'report.pdf');
    writeFileSync(pdf, '%PDF-1.7');

    const stored = await copyIntoPasted({ subChatId, sourcePath: pdf }, userData);

    expect(dirname(stored.filePath)).toBe(join(userData, 'claude-sessions', subChatId, 'pasted'));
    expect(basename(stored.filePath)).toMatch(/^[0-9a-f]{8}-report\.pdf$/);
    expect(stored.size).toBe(8);
    expect(readFileSync(stored.filePath, 'utf-8')).toBe('%PDF-1.7');
  });

  it('accepts a file of exactly the size limit, matching the "or smaller" wording', async () => {
    const exact = join(source, 'exact.csv');
    writeFileSync(exact, Buffer.alloc(PASTED_FILE_MAX_BYTES));

    const stored = await copyIntoPasted({ subChatId, sourcePath: exact }, userData);

    expect(stored.size).toBe(PASTED_FILE_MAX_BYTES);
  });

  it('refuses folders, relative paths, oversize files and unsafe session ids', async () => {
    const folder = join(source, 'folder');
    mkdirSync(folder);
    const big = join(source, 'big.csv');
    writeFileSync(big, Buffer.alloc(PASTED_FILE_MAX_BYTES + 1));
    const small = join(source, 'a.ts');
    writeFileSync(small, 'x');

    const attach = (id: string, sourcePath: string) =>
      copyIntoPasted({ subChatId: id, sourcePath }, userData);

    await expect(attach(subChatId, folder)).rejects.toThrow("Folders can't be attached.");
    await expect(attach(subChatId, 'a.ts')).rejects.toThrow('absolute');
    await expect(attach(subChatId, big)).rejects.toThrow(PASTED_FILE_TOO_LARGE);
    await expect(attach('__new_chat_0__', small)).rejects.toThrow('Invalid subChatId');
    await expect(attach('../escape', small)).rejects.toThrow('Invalid subChatId');
    expect(existsSync(join(userData, 'claude-sessions'))).toBe(false);
  });

  it('names pasted text by its kind, never in the shape of an attached file', async () => {
    const pasted = await writePastedText({ subChatId, text: 'hello' }, userData);
    const terminal = await writePastedText({ subChatId, text: 'x', kind: 'terminal' }, userData);

    expect(readFileSync(pasted.filePath, 'utf-8')).toBe('hello');
    expect(pasted.filename).toMatch(/^pasted_\d+\.txt$/);
    expect(terminal.filename).toMatch(/^terminal_\d+\.txt$/);
    for (const { filePath } of [pasted, terminal]) {
      expect(isAttachedFilePath(filePath)).toBe(false);
    }
  });

  it('reports the size of pasted text in bytes', async () => {
    const stored = await writePastedText({ subChatId, text: 'é'.repeat(10) }, userData);
    expect(stored.size).toBe(20);
  });

  it('refuses pasted text for an unsafe session id', async () => {
    await expect(
      writePastedText({ subChatId: '__new_chat_0__', text: 'x' }, userData),
    ).rejects.toThrow('Invalid subChatId');
  });

  it('explains a file that is gone or unreadable in plain words, not a system error', async () => {
    await expect(
      copyIntoPasted({ subChatId, sourcePath: join(source, 'deleted.pdf') }, userData),
    ).rejects.toThrow("Frink couldn't open this file. Check it still exists and try again.");
  });

  it('keeps the extension of a long name and fits it within every file system', () => {
    const paper = `${'Smith et al 2024 a very long title about agents '.repeat(4)}.pdf`;
    const cjk = `${'报告'.repeat(100)}.csv`;

    expect(safeAttachmentName(paper).endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(safeAttachmentName(paper))).toBeLessThanOrEqual(200);
    expect(safeAttachmentName(cjk).endsWith('.csv')).toBe(true);
    expect(Buffer.byteLength(safeAttachmentName(cjk))).toBeLessThanOrEqual(200);
    expect(safeAttachmentName(`a${'🙂'.repeat(150)}`)).not.toMatch(/\p{Cs}/u);
  });

  it('names a Windows path whole, spaces and backslashes included', () => {
    expect(attachedFileNote('C:\\Users\\a b\\r.csv')).toContain('`C:\\Users\\a b\\r.csv`');
  });

  // safeAttachmentName keeps backticks, so a single-backtick span would end inside the name.
  it('names a path holding a backtick whole', () => {
    expect(attachedFileNote('/p/report`1.csv')).toContain('`` /p/report`1.csv ``');
  });

  it('keeps names safe on every OS and inside a mention token', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeAttachmentName('a[b]|c.pdf')).toBe('a_b__c.pdf');
    expect(safeAttachmentName('notes:v2?.txt')).toBe('notes_v2_.txt');
    expect(safeAttachmentName('<draft>*"final"')).toBe('_draft___final_');
    expect(safeAttachmentName('trailing. . ')).toBe('trailing');
    expect(safeAttachmentName('   ')).toBe('attachment');
  });

  it('copies the pastes a message names into a replacement chat folder and repoints them', async () => {
    const original = join(source, 'report.pdf');
    writeFileSync(original, '%PDF');
    const pdf = await copyIntoPasted({ subChatId, sourcePath: original }, userData);
    const elsewhere = join(source, 'notes.txt');
    writeFileSync(elsewhere, 'mine');
    const missing = join(dirname(pdf.filePath), '0f9e8d7c-gone.csv');
    const to = 'fresh-sub-chat-id-01';
    const text = `@[pasted:4:report.pdf|${pdf.filePath}] @[pasted:4:notes|${elsewhere}] @[pasted:1:gone.csv|${missing}] go`;

    const out = await rehomePastedMentions(text, to, userData);

    const copy = join(userData, 'claude-sessions', to, 'pasted', pdf.filename);
    expect(readFileSync(copy, 'utf-8')).toBe('%PDF');
    expect(out).toBe(
      `@[pasted:4:report.pdf|${copy}] @[pasted:4:notes|${elsewhere}] @[pasted:1:gone.csv|${missing}] go`,
    );
  });

  // The target folder is one Claude reads without asking, so a path that only LOOKS like it starts
  // inside a pasted folder must never pull an outside file into it.
  it('never copies a file a mention reaches by stepping out of a pasted folder', async () => {
    const secret = join(userData, 'secret.txt');
    writeFileSync(secret, 'key');
    // Built by hand: join() would resolve the `..` segments away.
    const pasted = join(userData, 'claude-sessions', subChatId, 'pasted');
    const text = `@[pasted:1:s|${pasted}/../../../secret.txt]`;

    expect(await rehomePastedMentions(text, 'fresh-sub-chat-id-01', userData)).toBe(text);
    expect(existsSync(join(userData, 'claude-sessions', 'fresh-sub-chat-id-01'))).toBe(false);
  });

  it('leaves a paste alone when its folder could not belong to a sub-chat', async () => {
    const folder = join(userData, 'claude-sessions', '__new_chat_0__', 'pasted');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'x.txt'), 'x');
    const text = `@[pasted:1:x|${join(folder, 'x.txt')}]`;

    expect(await rehomePastedMentions(text, subChatId, userData)).toBe(text);
  });
});

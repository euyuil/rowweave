#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ApiFailure, createWorkspaceClient, maxCsvBytes, maxAttachmentBytes, type AttachmentUpload, type CsvImportRequest, type CsvExportRequest } from '../../../packages/client/src/index.js';
import { writeTextFile, writeBinaryFile } from '../../../packages/node-host/src/files.js';
import { commands, help, inputObject, UsageError } from './commands.js';

const maxJsonBytes = 8 * 1024 * 1024;

async function readBytes(path: string, limit: number): Promise<Buffer> {
  const stream = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new UsageError(`Input exceeds ${limit / 1024 / 1024} MiB.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readText(path: string, limit: number): Promise<string> {
  const bytes = await readBytes(path, limit);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new UsageError('Input must be valid UTF-8.'); }
}

async function run(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, url: { type: 'string' }, input: { type: 'string' },
      json: { type: 'string' }, file: { type: 'string' }, output: { type: 'string' },
    } });
  } catch (error) { throw new UsageError((error as Error).message); }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [resource, action, ...ids] = positionals;
  const name = `${resource} ${action}`;
  const command = commands[name];
  const csv = resource === 'csv' && ['preview', 'import', 'export'].includes(action!);
  const attachmentUpload = resource === 'attachments' && action === 'upload';
  const attachmentDownload = resource === 'attachments' && action === 'download';
  if (!command && !csv && !attachmentUpload && !attachmentDownload) throw new UsageError('Unknown command. Run rowweave --help for available operations.');
  const idCount = command?.ids ?? (attachmentDownload ? 2 : 1);
  if (ids.length !== idCount) throw new UsageError(`${name} requires ${idCount} ID argument(s).`);
  const mode = command?.input ?? (attachmentDownload ? 'none' : action === 'export' || attachmentUpload ? 'optional' : 'required');
  const provided = values.input !== undefined || values.json !== undefined;
  if (values.input !== undefined && values.json !== undefined) throw new UsageError('Use either --input or --json.');
  if (mode === 'required' && !provided) throw new UsageError('This command requires --input or --json.');
  if (mode === 'none' && provided) throw new UsageError('This command does not accept a JSON body.');
  if (values.file !== undefined && !attachmentUpload && (!csv || action === 'export')) throw new UsageError('--file is only used for CSV preview/import or attachment upload.');
  if (((csv && action !== 'export') || attachmentUpload) && !values.file) throw new UsageError('This operation requires --file.');
  if (values.output !== undefined && !attachmentDownload && (!csv || action !== 'export')) throw new UsageError('--output is only used for CSV export or attachment download.');
  if (attachmentDownload && !values.output) throw new UsageError('Attachment download requires --output.');
  if (values.input === '-' && values.file === '-') throw new UsageError('JSON and file content cannot both read stdin.');
  const url = values.url ?? process.env['ROWWEAVE_URL'] ?? 'http://127.0.0.1:4317';
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new UsageError('Use a valid HTTP or HTTPS service URL.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new UsageError('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  }
  const token = process.env['ROWWEAVE_TOKEN'];
  if (!token) throw new UsageError('Set ROWWEAVE_TOKEN in the environment.');
  try { new Headers({ Authorization: `Bearer ${token}` }); }
  catch { throw new UsageError('ROWWEAVE_TOKEN is not a valid HTTP header value.'); }
  const api = createWorkspaceClient({ url, token });
  let input: unknown = {};
  if (provided) {
    const text = values.input !== undefined ? await readText(values.input, maxJsonBytes) : values.json!;
    if (Buffer.byteLength(text) > maxJsonBytes) throw new UsageError('JSON input exceeds 8 MiB.');
    try { input = JSON.parse(text) as unknown; }
    catch { throw new UsageError('The request body must be valid JSON.'); }
  }
  if (command) {
    const result = await command.run(api, ids, input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (attachmentUpload) {
    const options = inputObject(input);
    if (values.file === '-' && options['filename'] === undefined) throw new UsageError('Provide a filename in JSON when uploading from stdin.');
    const bytes = await readBytes(values.file!, maxAttachmentBytes);
    const result = await api.uploadAttachment(ids[0]!, { filename: options['filename'] === undefined ? basename(values.file!) : options['filename'],
      mediaType: options['mediaType'] === undefined ? 'application/octet-stream' : options['mediaType'], data: bytes.toString('base64') } as AttachmentUpload);
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (attachmentDownload) {
    const bytes = await api.downloadAttachment(ids[0]!, ids[1]!);
    const path = resolve(values.output!); await writeBinaryFile(path, bytes);
    process.stdout.write(JSON.stringify({ path, bytes: bytes.byteLength }) + '\n');
  } else if (action === 'export') {
    const result = await api.exportCsv(ids[0]!, input as CsvExportRequest);
    if (values.output !== undefined) {
      const path = resolve(values.output);
      await writeTextFile(path, result);
      process.stdout.write(JSON.stringify({ path, bytes: Buffer.byteLength(result, 'utf8') }) + '\n');
    } else process.stdout.write(result);
  } else {
    const options = inputObject(input);
    const request = { ...options, csv: await readText(values.file!, maxCsvBytes) } as unknown as CsvImportRequest;
    const result = action === 'preview' ? await api.previewCsv(ids[0]!, request) : await api.importCsv(ids[0]!, request);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

void run().catch((error: unknown) => {
  const failure = error instanceof ApiFailure ? { code: error.code, message: error.message, status: error.status }
    : { code: error instanceof UsageError ? 'INVALID_ARGUMENT' : 'OPERATION_FAILED', message: error instanceof Error ? error.message : 'The operation failed.' };
  process.stderr.write(JSON.stringify({ error: failure }) + '\n');
  process.exitCode = error instanceof UsageError ? 2 : 1;
});

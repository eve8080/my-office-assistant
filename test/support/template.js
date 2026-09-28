import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const template = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const lines = template.split('\n');
const indentOf = (line) => line.match(/^ */)[0].length;

// Lines belonging to a top-level resource (two-space indented key under Resources).
export function resourceBlock(name) {
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`Resource ${name} not found in template`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > 2)) end += 1;
  return lines.slice(start, end).join('\n');
}

// Lines of a YAML sequence item that starts with the given text, e.g. "- PathPattern: /sync/*".
export function sequenceItem(startText) {
  const start = lines.findIndex((line) => line.trim() === startText);
  if (start === -1) throw new Error(`Sequence item ${startText} not found in template`);
  const itemIndent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > itemIndent)) end += 1;
  return lines.slice(start, end).join('\n');
}

export function defaultCacheBehavior() {
  const start = lines.findIndex((line) => line.trim() === 'DefaultCacheBehavior:');
  const indent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > indent)) end += 1;
  return lines.slice(start, end).join('\n');
}

export function flowList(block, key) {
  const match = block.match(new RegExp(`${key}: \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${key} flow list not found`);
  return match[1].split(',').map((item) => item.trim()).filter(Boolean);
}

export function scalar(block, key) {
  const match = block.match(new RegExp(`^\\s*${key}: (.+)$`, 'm'));
  return match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
}

// Extract the literal block scalar under FunctionCode: | and dedent it.
export function functionCode(resourceName = 'NotesRequestValidator') {
  const blockLines = resourceBlock(resourceName).split('\n');
  const start = blockLines.findIndex((line) => /^\s+FunctionCode: \|\s*$/.test(line));
  if (start === -1) throw new Error('FunctionCode block scalar not found');
  const keyIndent = indentOf(blockLines[start]);
  const body = [];
  for (const line of blockLines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
    body.push(line);
  }
  const contentIndent = Math.min(...body.filter((line) => line.trim()).map(indentOf));
  return body.map((line) => line.slice(contentIndent)).join('\n').trimEnd();
}

// Run the CloudFront Function source in an isolated context and return its handler.
export function loadFunctionHandler(resourceName = 'NotesRequestValidator') {
  const context = vm.createContext({});
  vm.runInContext(`${functionCode(resourceName)}\nglobalThis.__handler = handler;`, context);
  return context.__handler;
}

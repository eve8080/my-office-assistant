import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctionHandler } from './support/template.js';

const handler = loadFunctionHandler();
const locator = 'a'.repeat(64);
const validUri = `/sync/notebooks/${locator}.json`;

function run({ method = 'GET', uri = validUri, headers = {} } = {}) {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), { value: String(value) }]),
  );
  const request = { method, uri, headers: lowered, querystring: {}, cookies: {} };
  const result = handler({ version: '1.0', context: { eventType: 'viewer-request' }, viewer: { ip: '192.0.2.1' }, request });
  return { request, result, forwarded: result === request };
}

const jsonPut = (headers = {}) => run({
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'content-length': '1024', ...headers },
});

test('function code is executed from the CloudFormation template', () => {
  assert.equal(typeof handler, 'function');
});

test('valid notebook path and method is forwarded to the origin', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.ok(run({ method }).forwarded, `${method} should be forwarded`);
  }
  assert.ok(jsonPut().forwarded);
});

test('GET without a content type is forwarded', () => {
  assert.ok(run({ method: 'GET', headers: {} }).forwarded);
  assert.ok(run({ method: 'HEAD', headers: {} }).forwarded);
});

test('wrong paths are rejected with 400', () => {
  for (const uri of [
    '/sync/notebooks/short.json',
    `/sync/notebooks/${'A'.repeat(64)}.json`,
    `/sync/notebooks/${locator}.html`,
    `/sync/notebooks/${locator}.json/extra`,
    `/sync/other/${locator}.json`,
    `/sync/notebooks/../${locator}.json`,
    '/sync/',
    '/index.html',
  ]) {
    assert.equal(run({ uri }).result.statusCode, 400, uri);
  }
});

test('disallowed methods are rejected with 405 before reaching S3', () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const { result, forwarded } = run({ method, headers: { 'content-type': 'application/json' } });
    assert.equal(forwarded, false);
    assert.equal(result.statusCode, 405, method);
  }
});

test('oversized PUT is rejected with 413', () => {
  assert.equal(jsonPut({ 'content-length': '786433' }).result.statusCode, 413);
  assert.ok(jsonPut({ 'content-length': '786432' }).forwarded);
});

test('PUT with no content type is rejected with 415', () => {
  const { result } = run({ method: 'PUT', headers: { 'content-length': '10' } });
  assert.equal(result.statusCode, 415);
});

test('PUT with a non-JSON content type is rejected with 415', () => {
  for (const type of [
    'text/html',
    'text/plain',
    'application/javascript',
    'image/svg+xml',
    'application/json; charset=utf-8',
    'application/jsonp',
    'application/json, text/html',
    '',
  ]) {
    assert.equal(jsonPut({ 'content-type': type }).result.statusCode, 415, JSON.stringify(type));
  }
});

test('PUT with a repeated content-type header is rejected', () => {
  const request = {
    method: 'PUT',
    uri: validUri,
    headers: {
      'content-type': { value: 'application/json', multiValue: [{ value: 'application/json' }, { value: 'text/html' }] },
    },
  };
  assert.equal(handler({ request }).statusCode, 415);
});

test('PUT with application/json is accepted after trimming and lower-casing', () => {
  assert.ok(jsonPut({ 'content-type': 'application/json' }).forwarded);
  assert.ok(jsonPut({ 'content-type': '  Application/JSON  ' }).forwarded);
});

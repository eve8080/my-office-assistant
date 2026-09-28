import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');

test('infrastructure stores encrypted notebooks directly in a private S3 bucket', () => {
  assert.match(template, /NotesBucket:\n\s+Type: AWS::S3::Bucket/);
  assert.match(template, /Action:\n\s+- s3:GetObject\n\s+- s3:PutObject/);
  assert.match(template, /Resource: !Sub '\$\{NotesBucket\.Arn\}\/sync\/notebooks\/\*'/);
});

test('sync infrastructure requires no Lambda function or IAM execution role', () => {
  assert.doesNotMatch(template, /AWS::Lambda::/);
  assert.doesNotMatch(template, /AWS::IAM::Role/);
});

test('CloudFront validates encrypted notebook paths before the S3 origin', () => {
  assert.match(template, /Type: AWS::CloudFront::Function/);
  assert.match(template, /\/sync\/notebooks\/\[a-f0-9\]/);
  assert.match(template, /PathPattern: \/sync\/\*/);
});

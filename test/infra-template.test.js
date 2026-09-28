import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultCacheBehavior,
  flowList,
  functionCode,
  resourceBlock,
  scalar,
  sequenceItem,
} from './support/template.js';

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

const syncBehavior = sequenceItem('- PathPattern: /sync/*');
const siteBehavior = defaultCacheBehavior();
const notesHeaders = resourceBlock('NotesResponseHeadersPolicy');
const siteHeaders = resourceBlock('SiteResponseHeadersPolicy');
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

function csp(block) {
  return scalar(block, 'ContentSecurityPolicy');
}

test('/sync/* uses a dedicated response headers policy; the site policy stays on / only', () => {
  assert.equal(scalar(syncBehavior, 'ResponseHeadersPolicyId'), '!Ref NotesResponseHeadersPolicy');
  assert.equal(scalar(siteBehavior, 'ResponseHeadersPolicyId'), '!Ref SiteResponseHeadersPolicy');
  assert.match(notesHeaders, /Type: AWS::CloudFront::ResponseHeadersPolicy/);
  assert.equal((template.match(/!Ref NotesResponseHeadersPolicy/g) || []).length, 1);
});

test('/sync/* responses cannot execute as script', () => {
  const policy = csp(notesHeaders);
  const directives = Object.fromEntries(
    policy.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, ...values] = item.split(/\s+/);
      return [name, values];
    }),
  );
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives.sandbox, [], 'sandbox without allow-scripts or any other allowance');
  assert.equal(directives['script-src'], undefined, 'no script-src that could loosen default-src');
  assert.doesNotMatch(policy, /'self'|'unsafe-|https?:|\*|allow-/);
  assert.match(notesHeaders, /ContentSecurityPolicy:\n(?:.*\n)*?\s+Override: true/);
  assert.match(notesHeaders, /ContentTypeOptions:\n\s+Override: true/);
  assert.match(notesHeaders, /FrameOptions:\n\s+FrameOption: DENY\n\s+Override: true/);
  assert.match(notesHeaders, /ReferrerPolicy:\n\s+ReferrerPolicy: no-referrer\n\s+Override: true/);
  assert.match(notesHeaders, /StrictTransportSecurity:\n\s+AccessControlMaxAgeSec: 31536000\n\s+IncludeSubdomains: true\n\s+Override: true/);
});

test('/sync/* responses are not cached at the edge or by the browser', () => {
  assert.equal(scalar(syncBehavior, 'CachePolicyId'), CACHING_DISABLED);
  assert.match(
    notesHeaders,
    /CustomHeadersConfig:\n\s+Items:\n\s+- Header: Cache-Control\n\s+Value: no-store, max-age=0\n\s+Override: true/,
  );
  const customHeaders = [...notesHeaders.matchAll(/- Header: (.+)/g)].map((match) => match[1].trim());
  assert.deepEqual(customHeaders, ['Cache-Control'], 'only well-known custom headers CloudFront accepts');
});

test('the site policy for / keeps its original strength', () => {
  assert.equal(
    csp(siteHeaders),
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  assert.match(siteHeaders, /FrameOptions:\n\s+FrameOption: DENY/);
  assert.match(siteHeaders, /ContentTypeOptions:\n\s+Override: true/);
  assert.match(siteHeaders, /XSSProtection:\n\s+ModeBlock: true/);
  assert.equal(scalar(siteBehavior, 'CachePolicyId'), '658327ea-f89d-4fab-a63d-7e88639e58f6');
  assert.deepEqual(flowList(siteBehavior, 'AllowedMethods'), ['GET', 'HEAD', 'OPTIONS']);
});

test('/sync/* methods: only GET, HEAD, OPTIONS and PUT can reach S3', () => {
  const allowed = flowList(syncBehavior, 'AllowedMethods');
  const cached = flowList(syncBehavior, 'CachedMethods');
  // CloudFront accepts only three AllowedMethods sets; PUT requires the full set.
  assert.deepEqual(allowed, ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
  assert.ok(cached.every((method) => allowed.includes(method)), 'CachedMethods is a subset of AllowedMethods');
  // The viewer-request function is what stops POST/PATCH/DELETE before the origin.
  assert.match(syncBehavior, /EventType: viewer-request\n\s+FunctionARN: !GetAtt NotesRequestValidator\.FunctionARN/);
  assert.match(functionCode(), /var allowed = \['GET', 'HEAD', 'OPTIONS', 'PUT'\];/);
});

test('origin request policy forwards Content-Type, If-Match and If-None-Match', () => {
  const policy = resourceBlock('NotesOriginRequestPolicy');
  const headers = [...policy.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headers, ['Content-Type', 'If-Match', 'If-None-Match']);
  assert.match(policy, /HeaderBehavior: whitelist/);
  assert.match(policy, /CookieBehavior: none/);
  assert.match(policy, /QueryStringBehavior: none/);
  assert.equal(scalar(syncBehavior, 'OriginRequestPolicyId'), '!Ref NotesOriginRequestPolicy');
});

test('notes bucket stays private and the bucket policy is tightly scoped', () => {
  const bucket = resourceBlock('NotesBucket');
  for (const flag of ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']) {
    assert.match(bucket, new RegExp(`${flag}: true`));
  }
  const policy = resourceBlock('NotesBucketPolicy');
  const sourceArn = "AWS:SourceArn: !Sub 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${SiteDistribution}'";
  const statements = policy
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .split(/\n\s+- Sid: /)
    .slice(1)
    .map((body) => {
      const inlineAction = body.match(/\n\s+Action: (s3:[\w*]+)\s*(?:\n|$)/);
      const listActions = body.match(/\n\s+Action:\n((?:\s+- .+\n?)+)/);
      return {
        sid: body.split('\n')[0].trim(),
        body,
        actions: inlineAction
          ? [inlineAction[1]]
          : [...listActions[1].matchAll(/- (\S+)/g)].map((match) => match[1]),
        resource: body.match(/\n\s+Resource: (.+)/)[1].trim(),
      };
    });
  assert.deepEqual(statements.map((statement) => statement.sid), [
    'AllowCloudFrontEncryptedNotebookAccess',
    'AllowCloudFrontNotebookExistenceCheck',
  ]);
  // Every statement: Allow, only the CloudFront service principal, distribution-conditioned.
  for (const statement of statements) {
    assert.match(statement.body, /\n\s+Effect: Allow\n/, statement.sid);
    assert.equal((statement.body.match(/Service: /g) || []).length, 1, statement.sid);
    assert.match(statement.body, /\n\s+Service: cloudfront\.amazonaws\.com\n/, statement.sid);
    assert.doesNotMatch(statement.body, /AWS: ['"]?\*|Principal: ['"]?\*/, statement.sid);
    assert.match(statement.body, /Condition:\n\s+StringEquals:\n/, statement.sid);
    assert.ok(statement.body.includes(sourceArn), `${statement.sid} is conditioned on this distribution`);
    for (const action of statement.actions) assert.doesNotMatch(action, /\*/, `${statement.sid} has no wildcard action`);
  }
  assert.equal((policy.match(/Effect: /g) || []).length, 2);
  assert.doesNotMatch(policy, /Effect: Deny|NotAction|NotPrincipal|NotResource/);
  const [objects, existence] = statements;
  assert.deepEqual(objects.actions, ['s3:GetObject', 's3:PutObject']);
  assert.equal(objects.resource, "!Sub '${NotesBucket.Arn}/sync/notebooks/*'");
  assert.deepEqual(existence.actions, ['s3:ListBucket']);
  assert.equal(existence.resource, '!GetAtt NotesBucket.Arn', 'ListBucket only on the bucket ARN itself');
  assert.doesNotMatch(existence.body, /s3:prefix/);
  const allActions = statements.flatMap((statement) => statement.actions).sort();
  assert.deepEqual(allActions, ['s3:GetObject', 's3:ListBucket', 's3:PutObject']);
  const originsBlock = resourceBlock('SiteDistribution').match(/Origins:\n([\s\S]*?)\n\s+DefaultCacheBehavior:/)[1];
  const origins = [...originsBlock.matchAll(/^\s+- Id: (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(origins, ['private-site-s3-origin', 'private-notes-s3-origin']);
});

test('no new AWS services are introduced', () => {
  const types = [...new Set([...template.matchAll(/Type: (AWS::\S+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(types, [
    'AWS::CloudFront::Distribution',
    'AWS::CloudFront::Function',
    'AWS::CloudFront::OriginAccessControl',
    'AWS::CloudFront::OriginRequestPolicy',
    'AWS::CloudFront::ResponseHeadersPolicy',
    'AWS::S3::Bucket',
    'AWS::S3::BucketPolicy',
  ]);
  assert.doesNotMatch(template, /LambdaFunctionAssociations|AWS::WAFv2|AWS::ApiGateway|AWS::Cognito/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REGIONS, findRegion, PROVIDERS, LAND } from '../../src/clouds.js';
import { accessRoleTemplate, clusterEstimate, roleArnFrom, serviceEstimate, stackState } from './rules.mjs';

test('the region catalog covers the major clouds, and only AWS provisions', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['aws', 'azure', 'gcp', 'oracle', 'alibaba', 'ibm', 'digitalocean']);
  assert.equal(PROVIDERS.filter((p) => p.provisioning).map((p) => p.id).join(), 'aws');
  assert.equal(findRegion('aws', 'eu-west-1').city, 'Ireland');
  assert.equal(findRegion('aws', 'ap-east-1').optIn, true);
  for (const region of REGIONS) {
    assert.ok(region.lat >= -90 && region.lat <= 90 && region.lon >= -180 && region.lon <= 180, region.code);
  }
  assert.equal(LAND.length, 72);
  assert.ok(LAND.every((row) => row.length === 36));
});

test('estimates add up the parts', () => {
  assert.ok(Math.abs(clusterEstimate({ kind: 'kubernetes', nodeType: 't3.medium', nodes: 2 }).monthly - (73 + 60.74 + 7.3)) < 0.01);
  assert.equal(clusterEstimate({ kind: 'serverless' }).monthly, 0);
  assert.equal(serviceEstimate({ size: 'small', count: 1 }).lines.length, 3);
});

test('role ARNs and account IDs are accepted, nothing else', () => {
  assert.equal(roleArnFrom('111122223333'), 'arn:aws:iam::111122223333:role/LyrcloudAccess');
  assert.equal(roleArnFrom(' arn:aws:iam::111122223333:role/LyrcloudAccess '), 'arn:aws:iam::111122223333:role/LyrcloudAccess');
  assert.equal(roleArnFrom('arn:aws:iam::1111:role/x'), null);
  assert.equal(roleArnFrom('hello'), null);
});

test('stack states map to what customers see', () => {
  assert.deepEqual(['CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE', 'DELETE_IN_PROGRESS', 'DELETE_FAILED', undefined].map(stackState),
    ['creating', 'ready', 'failed', 'failed', 'updating', 'ready', 'deleting', 'delete_failed', 'deleted']);
});

test('the access role only trusts Lyrcloud with the ExternalId, and IAM is limited to lyrcloud-*', () => {
  const role = accessRoleTemplate('479664683751').Resources.Role.Properties;
  const trust = role.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Condition, { StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } } });
  const iam = role.Policies[0].PolicyDocument.Statement.find((s) => s.Sid === 'OwnRoles');
  assert.ok(iam.Resource.every((r) => r['Fn::Sub'].includes('/lyrcloud-*')));
  assert.equal(role.Policies[0].PolicyDocument.Statement.some((s) => [].concat(s.Action).includes('iam:*')), false);
});

// Lyrcloud Sites: DNS, CDN and HTTPS for any domain, bought here or elsewhere.
//
//   GET    /domains/sites                         your sites
//   POST   /domains/sites                         { domain } add one: a Route 53 zone with Lyrcloud's name servers,
//                                                 pre-filled with the records the domain answers today
//   GET    /domains/sites/{domain}                one site, its records, name server and CDN status
//   DELETE /domains/sites/{domain}                remove it (CDN off first; not for domains registered here)
//   PUT    /domains/sites/{domain}/records        { type, name, values[], ttl? } create or replace a record set
//   DELETE /domains/sites/{domain}/records?type=&name=
//   PUT    /domains/sites/{domain}/cdn            { mode: 'proxy', origin } | { mode: 'function', fn } | { mode: 'app', origin } turn the CDN on
//                                                 ('app': a cloud app such as Cloud Run, sent its own Host instead of the visitor's)
//                                                 or change the origin; { mode: 'off' } turns it off
//   POST   /domains/sites/{domain}/purge          { paths?: ['/a', '/b*'] } clear the CDN cache (everything by default)
//
// Every zone uses one reusable delegation set, so all sites share four name servers. A site is "pending"
// until the domain's name servers point at them, then "active". Only active sites can use the CDN.
//
// The CDN for a site is a CloudFront distribution tenant (infra/aws/sites.yml) covering the domain and www.
// Turning it on goes certificate -> deploying -> live, advanced whenever the site is read and by the
// scheduled run:
//   certificate: an ACM certificate (domain + www) validated through a CNAME we add to the zone, so it's
//                issued before any traffic moves and renews by itself while the CNAME stays.
//   deploying:   a tenant on the proxy or function distribution, with that certificate.
//   live:        once the tenant is deployed, the domain and www become aliases of CloudFront's routing
//                endpoint. Their old records are kept and put back when the CDN is turned off.
// Turning it off restores the records, disables the tenant (removing), then deletes it and the certificate.
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  ChangeResourceRecordSetsCommand, CreateHostedZoneCommand, CreateReusableDelegationSetCommand, DeleteHostedZoneCommand,
  GetReusableDelegationSetCommand, ListResourceRecordSetsCommand, ListReusableDelegationSetsCommand, Route53Client,
} from '@aws-sdk/client-route-53';
import {
  CloudFrontClient, CreateDistributionTenantCommand, CreateInvalidationForDistributionTenantCommand, DeleteDistributionTenantCommand,
  GetConnectionGroupCommand, GetDistributionTenantCommand, ListConnectionGroupsCommand, UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import { ACMClient, DeleteCertificateCommand, DescribeCertificateCommand, RequestCertificateCommand } from '@aws-sdk/client-acm';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cleanDomain, fromRecordSet, recordError, recordName, route53RecordSet } from './rules.mjs';

export const route53 = new Route53Client({ region: 'us-east-1' });
export const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
export const acm = new ACMClient({ region: 'us-east-1' }); // CloudFront only takes certificates from us-east-1
export const resolver = { current: null };

const CLOUDFRONT_ZONE = 'Z2FDTNDATAQYW2'; // the hosted zone of every *.cloudfront.net alias target
const SITE_LIMITS = { launch: 3 }; // sites per plan; plans not listed are unlimited
// Names whose records are copied into a new zone, besides the domain itself.
const IMPORT_LABELS = ['www', 'mail', 'webmail', 'smtp', 'imap', 'pop', 'ftp', 'api', 'app', 'blog', 'shop', 'store', 'admin', 'dev', 'staging',
  'cdn', 'static', 'm', 'portal', 'autodiscover', 'autoconfig', '_dmarc', 'default._domainkey', 'google._domainkey', 'selector1._domainkey', 'selector2._domainkey', 'k1._domainkey'];
const ORIGIN_LABEL = 'lyr-origin'; // origin.<domain> for proxies whose origin is an IP address
const now = () => new Date().toISOString();
const siteKey = (domain) => ({ pk: `site#${domain}`, sk: 'site' });
const DELEGATION_KEY = { pk: 'system', sk: 'delegation-set' };
const ROUTING_KEY = { pk: 'system', sk: 'cdn-routing' };

// Errors the customer may read. Everything else is logged and reported as a generic failure.
export class SiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// What the public answers for a name right now, from public resolvers (not from our own zone).
function publicResolver() {
  if (resolver.current) return resolver.current;
  const r = new Resolver({ timeout: 2500, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

const lower = (list) => list.map((ns) => String(ns).toLowerCase().replace(/\.$/, ''));

// True when the domain's public NS records are exactly our name servers.
export async function delegatedTo(domain, nameservers) {
  try {
    const answer = lower(await publicResolver().resolveNs(domain));
    const ours = lower(nameservers);
    return answer.length > 0 && answer.every((ns) => ours.includes(ns));
  } catch {
    return false;
  }
}

// The records `domain` answers today for the common names, as our record sets, for pre-filling its zone.
export async function currentRecords(domain) {
  const r = publicResolver();
  const tryResolve = async (fn) => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const lookup = async (label) => {
    const sets = [];
    const host = label === '@' ? domain : `${label}.${domain}`;
    const cname = label === '@' ? [] : await tryResolve(() => r.resolveCname(host));
    if (cname.length) return [{ type: 'CNAME', name: label, values: [cname[0]], ttl: 300 }];
    const [a, aaaa, mx, txt] = await Promise.all([
      tryResolve(() => r.resolve4(host)), tryResolve(() => r.resolve6(host)), tryResolve(() => r.resolveMx(host)), tryResolve(() => r.resolveTxt(host)),
    ]);
    if (a.length) sets.push({ type: 'A', name: label, values: a, ttl: 300 });
    if (aaaa.length) sets.push({ type: 'AAAA', name: label, values: aaaa, ttl: 300 });
    if (mx.length) sets.push({ type: 'MX', name: label, values: mx.map(({ priority, exchange }) => `${priority} ${exchange}`), ttl: 300 });
    if (txt.length) sets.push({ type: 'TXT', name: label, values: txt.map((parts) => parts.join('')), ttl: 300 });
    return sets;
  };
  const sets = (await Promise.all(['@', ...IMPORT_LABELS].map(lookup))).flat();
  return sets.filter((set) => !recordError(set, domain));
}

// ---------------------------------------------------------------- the sites service

export function createSites(ctx) {
  const { ddb, TABLE, FUNCTIONS_TABLE, PROXY_DISTRIBUTION_ID, FUNCTION_DISTRIBUTION_ID, APP_DISTRIBUTION_ID } = ctx;
  const getItem = async (key, table = TABLE) => (await ddb.send(new GetCommand({ TableName: table, Key: key }))).Item;
  const putItem = (item, condition) => ddb.send(new PutCommand({ TableName: TABLE, Item: item, ...(condition || {}) }));
  async function save(site, set, remove = []) {
    const next = { ...site, ...set, updatedAt: now() };
    for (const field of remove) delete next[field];
    await putItem(next);
    return next;
  }
  const cdnOn = () => Boolean(PROXY_DISTRIBUTION_ID && FUNCTION_DISTRIBUTION_ID);

  // The shared name servers: one reusable delegation set, made the first time a site is added.
  async function delegationSet() {
    const stored = await getItem(DELEGATION_KEY);
    if (stored?.id) return stored;
    let set;
    const existing = (await route53.send(new ListReusableDelegationSetsCommand({}))).DelegationSets || [];
    const ours = existing.find((item) => item.CallerReference === 'lyrcloud-sites');
    if (ours) set = ours;
    else set = (await route53.send(new CreateReusableDelegationSetCommand({ CallerReference: 'lyrcloud-sites' }))).DelegationSet;
    const item = { ...DELEGATION_KEY, id: set.Id.replace('/delegationset/', ''), nameservers: lower(set.NameServers), createdAt: now() };
    await putItem(item);
    return item;
  }

  // CloudFront's routing endpoint for tenants (the default connection group's address).
  async function routingEndpoint() {
    const stored = await getItem(ROUTING_KEY);
    if (stored?.endpoint) return stored.endpoint;
    const groups = (await cloudfront.send(new ListConnectionGroupsCommand({}))).ConnectionGroups || [];
    const group = groups.find((item) => item.IsDefault) || groups[0];
    if (!group) throw new Error('CloudFront has no connection group yet');
    const detail = (await cloudfront.send(new GetConnectionGroupCommand({ Identifier: group.Id }))).ConnectionGroup;
    const endpoint = detail?.RoutingEndpoint || group.RoutingEndpoint;
    await putItem({ ...ROUTING_KEY, endpoint, groupId: group.Id, at: now() });
    return endpoint;
  }

  async function zoneRecords(zoneId) {
    const records = [];
    let start = {};
    for (;;) {
      const page = await route53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, MaxItems: 300, ...start }));
      records.push(...(page.ResourceRecordSets || []));
      if (!page.IsTruncated) break;
      start = { StartRecordName: page.NextRecordName, StartRecordType: page.NextRecordType };
    }
    return records;
  }
  const setName = (set) => String(set.Name).replace(/\.$/, '').replace(/\\052/g, '*');
  const change = (zoneId, changes, comment = 'Lyrcloud') => (changes.length
    ? route53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Comment: comment, Changes: changes } }))
    : null);

  // Makes the Route 53 zone for `domain` with the shared name servers. Returns { zoneId, nameservers }.
  async function createZone(domain) {
    const set = await delegationSet();
    try {
      const made = await route53.send(new CreateHostedZoneCommand({
        Name: domain, CallerReference: `site-${domain}-${randomUUID()}`, DelegationSetId: set.id,
        HostedZoneConfig: { Comment: 'Lyrcloud site', PrivateZone: false },
      }));
      return { zoneId: made.HostedZone.Id.replace('/hostedzone/', ''), nameservers: set.nameservers };
    } catch (err) {
      if (err.name === 'HostedZoneAlreadyExists' || err.name === 'ConflictingDomainExists') throw new SiteError(409, `${domain} is already set up on Lyrcloud.`);
      if (err.name === 'DelegationSetNotAvailable') throw new SiteError(409, `${domain} can’t use Lyrcloud’s name servers. Contact support.`);
      if (err.name === 'TooManyHostedZones' || err.name === 'LimitsExceeded') {
        console.error('ROUTE 53 LIMIT REACHED: raise the hosted zone / delegation set quota', err.name, err.message);
        throw new SiteError(503, 'Lyrcloud can’t add more sites right now. Contact support.');
      }
      throw err;
    }
  }

  // ---- public shape

  function publicSite(site, records) {
    const cdn = site.cdn || null;
    return {
      domain: site.domain, status: site.status, source: site.source, nameservers: site.nameservers, createdAt: site.createdAt,
      activatedAt: site.activatedAt || null, checkedAt: site.checkedAt || null, registered: site.source === 'registered',
      cdn: cdn ? { mode: cdn.mode, origin: cdn.origin || null, fn: cdn.fn || null, status: cdn.status, hosts: cdn.hosts, message: cdn.message || null, liveAt: cdn.liveAt || null } : null,
      cdnAvailable: cdnOn(),
      ...(records ? { records } : {}),
    };
  }

  // Customer-editable records, plus read-only entries for what the CDN and its certificate manage.
  async function recordsOf(site) {
    const sets = await zoneRecords(site.zoneId);
    const out = [];
    for (const set of sets) {
      const name = setName(set);
      if (set.AliasTarget) {
        out.push({ type: set.Type, name, label: name === site.domain ? '@' : name.slice(0, -(site.domain.length + 1)), values: ['Lyrcloud CDN'], ttl: null, managed: 'cdn' });
        continue;
      }
      if (site.cdn?.validation?.some((v) => v.name === name && set.Type === 'CNAME')) {
        out.push({ ...fromRecordSet(set, site.domain), managed: 'certificate' });
        continue;
      }
      const record = fromRecordSet(set, site.domain);
      if (record) out.push(record);
    }
    return out;
  }

  // ---- adding and removing

  async function addSite({ domain: input, ownerId, ownerEmail, plan, source = 'external', importRecords = true, isStaffCaller = false }) {
    const domain = cleanDomain(input);
    if (!domain) throw new SiteError(400, 'Enter a domain like example.com.');
    if (await getItem(siteKey(domain))) throw new SiteError(409, `${domain} is already on Lyrcloud.`);
    const limit = SITE_LIMITS[plan || 'launch'];
    if (limit && !isStaffCaller && source === 'external') {
      const mine = (await ctx.itemsOf(ownerId)).filter((item) => item.kind === 'site');
      if (mine.length >= limit) throw new SiteError(409, `Your plan includes ${limit} sites. Upgrade to add more.`);
    }
    const records = importRecords ? await currentRecords(domain).catch(() => []) : [];
    const { zoneId, nameservers } = await createZone(domain);
    const site = {
      ...siteKey(domain), kind: 'site', domain, ownerId, ownerEmail: ownerEmail || null, source, zoneId, nameservers,
      status: 'pending', createdAt: now(), importedRecords: records.length,
    };
    try {
      await putItem(site, { ConditionExpression: 'attribute_not_exists(pk)' });
    } catch (err) {
      await route53.send(new DeleteHostedZoneCommand({ Id: zoneId })).catch(() => {});
      if (err.name === 'ConditionalCheckFailedException') throw new SiteError(409, `${domain} is already on Lyrcloud.`);
      throw err;
    }
    // Route 53 takes up to 1000 changes in a batch; a domain's common names are far fewer.
    await change(zoneId, records.map((record) => ({ Action: 'UPSERT', ResourceRecordSet: route53RecordSet(record, domain) })), 'Copied when the site was added')
      ?.catch((err) => console.error('record import failed', domain, err.name, err.message));
    return site;
  }

  async function removeSite(site) {
    if (site.cdn) throw new SiteError(409, 'Turn the CDN off first.');
    if (site.source === 'registered') throw new SiteError(409, 'This domain is registered with Lyrcloud and uses this DNS. It can’t be removed here.');
    const sets = await zoneRecords(site.zoneId);
    const deletable = sets.filter((set) => !(['NS', 'SOA'].includes(set.Type) && setName(set) === site.domain));
    await change(site.zoneId, deletable.map((set) => ({ Action: 'DELETE', ResourceRecordSet: set })));
    await route53.send(new DeleteHostedZoneCommand({ Id: site.zoneId }));
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: siteKey(site.domain) }));
  }

  // ---- records

  // The apex and www belong to the CDN while it's on (its certificate's CNAMEs always do).
  const cdnHosts = (site) => (site.cdn ? site.cdn.hosts : []);
  async function putRecord(site, record) {
    const refused = recordError(record, site.domain);
    if (refused) throw new SiteError(...refused);
    const name = recordName(record.name, site.domain);
    if (cdnHosts(site).includes(name) && ['A', 'AAAA', 'CNAME'].includes(record.type)) {
      throw new SiteError(409, `${name} is served by the Lyrcloud CDN. Change the CDN’s origin instead, or turn the CDN off.`);
    }
    if (site.cdn?.validation?.some((v) => v.name === name)) throw new SiteError(409, `${name} validates the site’s HTTPS certificate and can’t be changed.`);
    const existing = (await zoneRecords(site.zoneId)).filter((set) => setName(set) === name);
    const conflict = existing.find((set) => (set.Type === 'CNAME') !== (record.type === 'CNAME') && !['NS', 'SOA'].includes(set.Type));
    if (conflict) throw new SiteError(400, `${name} already has a ${conflict.Type} record. A CNAME can’t share its name with other records.`);
    try {
      await change(site.zoneId, [{ Action: 'UPSERT', ResourceRecordSet: route53RecordSet(record, site.domain) }], 'Lyrcloud dashboard');
    } catch (err) {
      if (err.name === 'InvalidChangeBatch' || err.name === 'InvalidInput') throw new SiteError(400, err.message);
      throw err;
    }
  }

  async function deleteRecord(site, type, rawName) {
    const name = recordName(rawName, site.domain);
    if (cdnHosts(site).includes(name) && ['A', 'AAAA', 'CNAME'].includes(type)) throw new SiteError(409, `${name} is served by the Lyrcloud CDN. Turn the CDN off to change it.`);
    const existing = (await zoneRecords(site.zoneId)).find((set) => set.Type === type && setName(set) === name && !set.AliasTarget);
    if (!existing || !['A', 'AAAA', 'CNAME', 'MX', 'TXT'].includes(type)) throw new SiteError(404, 'No such record.');
    if (site.cdn?.validation?.some((v) => v.name === name)) throw new SiteError(409, `${name} validates the site’s HTTPS certificate and can’t be removed.`);
    await change(site.zoneId, [{ Action: 'DELETE', ResourceRecordSet: existing }]);
  }

  // ---- name servers

  async function checkDelegation(site) {
    if (site.status === 'active') return site;
    const ok = await delegatedTo(site.domain, site.nameservers);
    return save(site, ok ? { status: 'active', activatedAt: now(), checkedAt: now() } : { checkedAt: now() });
  }

  // ---- CDN

  // Validates { mode, origin | fn } and returns the CDN settings (without status), resolving IP origins.
  async function cdnSettings(site, body) {
    if (body?.mode === 'proxy') {
      const raw = String(body.origin || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
      if (isIP(raw) === 4) return { mode: 'proxy', origin: raw, originHost: `${ORIGIN_LABEL}.${site.domain}` };
      if (isIP(raw) === 6 || raw.includes(':')) throw new SiteError(400, 'Use an IPv4 address or a host name for the origin.');
      const host = cleanDomain(raw) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null);
      if (!host) throw new SiteError(400, 'Enter your server’s IPv4 address or host name, like 203.0.113.10 or origin.example.net.');
      if ([site.domain, `www.${site.domain}`].includes(host)) {
        throw new SiteError(400, `The origin can’t be ${host} itself, because that will point at the CDN. Use your server’s IP address or another host name.`);
      }
      return { mode: 'proxy', origin: host, originHost: host };
    }
    if (body?.mode === 'app') {
      if (!APP_DISTRIBUTION_ID) throw new SiteError(503, 'Putting cloud apps behind the CDN isn’t switched on yet.');
      const host = String(body.origin || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || isIP(host)) throw new SiteError(400, 'Enter your app’s own address, like web-abc.a.run.app.');
      if ([site.domain, `www.${site.domain}`].includes(host)) throw new SiteError(400, 'Use the app’s own address, not this domain.');
      return { mode: 'app', origin: host, originHost: host };
    }
    if (body?.mode === 'function') {
      const fn = String(body.fn || '').trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(fn)) throw new SiteError(400, 'Choose one of your Edge Functions.');
      const item = FUNCTIONS_TABLE ? await getItem({ pk: `fn#${fn}`, sk: 'fn' }, FUNCTIONS_TABLE) : null;
      if (!item || item.ownerId !== site.ownerId) throw new SiteError(404, `You don’t have an Edge Function called ${fn}.`);
      return { mode: 'function', fn };
    }
    throw new SiteError(400, 'Send { "mode": "proxy", "origin": "…" }, { "mode": "app", "origin": "…" }, { "mode": "function", "fn": "…" } or { "mode": "off" }.');
  }

  // Which hosts the CDN covers: the domain, and www unless www points somewhere other than the site.
  async function hostsFor(site) {
    const www = `www.${site.domain}`;
    const sets = await zoneRecords(site.zoneId);
    const wwwSet = sets.find((set) => setName(set) === www && ['A', 'AAAA', 'CNAME'].includes(set.Type));
    if (!wwwSet || wwwSet.Type !== 'CNAME') return [site.domain, www];
    const target = String(wwwSet.ResourceRecords?.[0]?.Value || '').toLowerCase().replace(/\.$/, '');
    return target === site.domain ? [site.domain, www] : [site.domain];
  }

  const originParam = (cdn) => (cdn.mode === 'function' ? [{ Name: 'fn', Value: cdn.fn }] : [{ Name: 'origin', Value: cdn.originHost }]);
  const distributionFor = (mode) => (mode === 'proxy' ? PROXY_DISTRIBUTION_ID : mode === 'app' ? APP_DISTRIBUTION_ID : FUNCTION_DISTRIBUTION_ID);
  const tenantName = (domain) => `site-${domain.replace(/[^a-z0-9-]/g, '-')}`.slice(0, 120);

  // An IP origin gets lyr-origin.<domain> in the site's own zone, since CloudFront origins are host names.
  async function writeOriginRecord(site, cdn) {
    if (cdn.mode !== 'proxy' || cdn.originHost !== `${ORIGIN_LABEL}.${site.domain}`) return;
    await change(site.zoneId, [{ Action: 'UPSERT', ResourceRecordSet: { Name: cdn.originHost, Type: 'A', TTL: 300, ResourceRecords: [{ Value: cdn.origin }] } }], 'Lyrcloud CDN origin');
  }

  async function setCdn(site, body) {
    if (body?.mode === 'off') return turnCdnOff(site);
    if (!cdnOn()) throw new SiteError(503, 'The Lyrcloud CDN isn’t switched on yet.');
    if (site.status !== 'active') throw new SiteError(409, 'Point the domain at Lyrcloud’s name servers first. The CDN can be turned on once they’re in place.');
    if (site.cdn && site.cdn.status === 'removing') throw new SiteError(409, 'The CDN is still turning off. Try again in a few minutes.');
    if (site.cdn && ['proxy', 'function', 'app'].includes(body?.mode) && site.cdn.mode !== body.mode) {
      throw new SiteError(409, 'Turn the CDN off before switching between your own server, a cloud app and an Edge Function.');
    }
    const settings = await cdnSettings(site, body);
    if (site.cdn) {
      // Same mode, new origin: update the tenant in place (or just the settings, if it isn't made yet).
      await writeOriginRecord(site, settings);
      const cdn = { ...site.cdn, ...settings };
      if (site.cdn.tenantId) {
        const { DistributionTenant: tenant, ETag } = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: site.cdn.tenantId }));
        await cloudfront.send(new UpdateDistributionTenantCommand({
          Id: tenant.Id, IfMatch: ETag, DistributionId: tenant.DistributionId, Domains: tenant.Domains.map(({ Domain }) => ({ Domain })),
          Parameters: originParam(cdn), Customizations: tenant.Customizations, Enabled: true,
        }));
      }
      return save(site, { cdn });
    }
    const hosts = await hostsFor(site);
    await writeOriginRecord(site, settings);
    const cert = await acm.send(new RequestCertificateCommand({
      DomainName: site.domain, SubjectAlternativeNames: hosts.filter((host) => host !== site.domain), ValidationMethod: 'DNS',
      IdempotencyToken: site.domain.replace(/[^a-z0-9]/g, '').slice(0, 32), Tags: [{ Key: 'lyrcloud', Value: 'site' }, { Key: 'site', Value: site.domain }],
      Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
    }));
    const next = await save(site, { cdn: { ...settings, hosts, status: 'certificate', certificateArn: cert.CertificateArn, startedAt: now(), message: 'Issuing the HTTPS certificate.' } });
    return advanceCdn(next);
  }

  async function turnCdnOff(site) {
    if (!site.cdn) return site;
    if (site.cdn.status === 'removing') return site;
    // Put the domain's own records back first, so visitors go straight to the old destination.
    if (site.cdn.status === 'live') await restoreRecords(site);
    const cdn = { ...site.cdn, status: 'removing', message: 'Turning the CDN off.' };
    if (cdn.tenantId) {
      try {
        const { DistributionTenant: tenant, ETag } = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: cdn.tenantId }));
        if (tenant.Enabled) {
          await cloudfront.send(new UpdateDistributionTenantCommand({
            Id: tenant.Id, IfMatch: ETag, DistributionId: tenant.DistributionId, Domains: tenant.Domains.map(({ Domain }) => ({ Domain })),
            Parameters: tenant.Parameters, Customizations: tenant.Customizations, Enabled: false,
          }));
        }
      } catch (err) {
        if (err.name !== 'EntityNotFound') throw err;
        delete cdn.tenantId;
      }
    }
    return advanceCdn(await save(site, { cdn }));
  }

  // Keeps the apex and www record sets that the CDN's aliases replace, then points them at CloudFront.
  async function switchToCdn(site) {
    const endpoint = await routingEndpoint();
    const sets = await zoneRecords(site.zoneId);
    const previous = sets.filter((set) => site.cdn.hosts.includes(setName(set)) && ['A', 'AAAA', 'CNAME'].includes(set.Type) && !set.AliasTarget);
    const alias = (name, type) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: name, Type: type, AliasTarget: { HostedZoneId: CLOUDFRONT_ZONE, DNSName: endpoint, EvaluateTargetHealth: false } } });
    await change(site.zoneId, [
      ...previous.map((set) => ({ Action: 'DELETE', ResourceRecordSet: set })),
      ...site.cdn.hosts.flatMap((host) => [alias(host, 'A'), alias(host, 'AAAA')]),
    ], 'Lyrcloud CDN on');
    return previous;
  }

  async function restoreRecords(site) {
    const sets = await zoneRecords(site.zoneId);
    const aliases = sets.filter((set) => set.AliasTarget && site.cdn.hosts.includes(setName(set)));
    await change(site.zoneId, [
      ...aliases.map((set) => ({ Action: 'DELETE', ResourceRecordSet: set })),
      ...(site.cdn.previous || []).map((set) => ({ Action: 'CREATE', ResourceRecordSet: set })),
    ], 'Lyrcloud CDN off');
  }

  // Moves an in-progress CDN change on as far as it can go right now. Never throws for AWS being slow.
  async function advanceCdn(site) {
    const cdn = site.cdn;
    if (!cdn || cdn.status === 'live') return site;
    try {
      if (cdn.status === 'certificate') {
        const { Certificate: cert } = await acm.send(new DescribeCertificateCommand({ CertificateArn: cdn.certificateArn }));
        const options = (cert.DomainValidationOptions || []).filter((option) => option.ResourceRecord);
        if (options.length && !cdn.validation) {
          const validation = [...new Map(options.map(({ ResourceRecord: r }) => [r.Name, { name: r.Name.replace(/\.$/, ''), value: r.Value }])).values()];
          await change(site.zoneId, validation.map((v) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: v.name, Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: v.value }] } })), 'Certificate validation');
          site = await save(site, { cdn: { ...cdn, validation } });
        }
        if (cert.Status === 'FAILED' || cert.Status === 'VALIDATION_TIMED_OUT') {
          return save(site, { cdn: { ...site.cdn, status: 'error', message: `The certificate couldn’t be issued (${cert.FailureReason || cert.Status}). Turn the CDN off and on to try again.` } });
        }
        if (cert.Status !== 'ISSUED') return site;
        const made = await cloudfront.send(new CreateDistributionTenantCommand({
          DistributionId: distributionFor(site.cdn.mode), Name: tenantName(site.domain), Enabled: true,
          Domains: site.cdn.hosts.map((Domain) => ({ Domain })), Parameters: originParam(site.cdn),
          Customizations: { Certificate: { Arn: site.cdn.certificateArn } },
          Tags: { Items: [{ Key: 'lyrcloud', Value: 'site' }, { Key: 'site', Value: site.domain }] },
        }));
        return advanceCdn(await save(site, { cdn: { ...site.cdn, status: 'deploying', tenantId: made.DistributionTenant.Id, message: 'Deploying to CloudFront’s edge locations.' } }));
      }
      if (cdn.status === 'deploying') {
        const { DistributionTenant: tenant } = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: cdn.tenantId }));
        if (tenant.Status !== 'Deployed') return site;
        const previous = await switchToCdn(site);
        return save(site, { cdn: { ...cdn, status: 'live', previous, liveAt: now(), message: null } });
      }
      if (cdn.status === 'removing') {
        if (cdn.tenantId) {
          let found;
          try {
            found = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: cdn.tenantId }));
          } catch (err) {
            if (err.name !== 'EntityNotFound') throw err;
          }
          if (found) {
            if (found.DistributionTenant.Enabled || found.DistributionTenant.Status !== 'Deployed') return site;
            await cloudfront.send(new DeleteDistributionTenantCommand({ Id: cdn.tenantId, IfMatch: found.ETag }));
          }
        }
        // The certificate goes once nothing uses it; its validation CNAMEs and any origin record with it.
        if (cdn.certificateArn) {
          await acm.send(new DeleteCertificateCommand({ CertificateArn: cdn.certificateArn })).catch((err) => {
            if (err.name !== 'ResourceNotFoundException') throw err;
          });
        }
        const sets = await zoneRecords(site.zoneId);
        const leftovers = sets.filter((set) => (cdn.validation || []).some((v) => v.name === setName(set) && set.Type === 'CNAME')
          || (cdn.mode === 'proxy' && setName(set) === `${ORIGIN_LABEL}.${site.domain}`));
        await change(site.zoneId, leftovers.map((set) => ({ Action: 'DELETE', ResourceRecordSet: set })), 'Lyrcloud CDN removed');
        return save(site, {}, ['cdn']);
      }
    } catch (err) {
      if (err.name === 'CNAMEAlreadyExists' || err.name === 'EntityAlreadyExists') {
        return save(site, { cdn: { ...cdn, status: 'error', message: 'Another CloudFront distribution already serves this domain. Remove it there first, then turn the CDN off and on.' } });
      }
      if (err.name === 'ResourceInUseException' || err.name === 'PreconditionFailed' || err.name === 'ThrottlingException' || err.name === 'TooManyRequestsException') return site;
      console.error('CDN step failed', site.domain, cdn.status, err.name, err.message);
      return site;
    }
    return site;
  }

  // Clears CloudFront's cache for the site, and the router's own cache for an Edge Function.
  async function purge(site, body) {
    if (site.cdn?.status !== 'live') throw new SiteError(409, 'The CDN isn’t on for this site.');
    const paths = Array.isArray(body?.paths) && body.paths.length ? body.paths.map(String) : ['/*'];
    if (paths.length > 30 || !paths.every((p) => /^\/[^\s]{0,500}$/.test(p))) throw new SiteError(400, 'Send up to 30 paths, each starting with /, like /index.html or /blog/*.');
    await cloudfront.send(new CreateInvalidationForDistributionTenantCommand({
      Id: site.cdn.tenantId, InvalidationBatch: { CallerReference: randomUUID(), Paths: { Quantity: paths.length, Items: paths } },
    }));
    if (site.cdn.mode === 'function' && FUNCTIONS_TABLE) {
      await ddb.send(new UpdateCommand({
        TableName: FUNCTIONS_TABLE, Key: { pk: `fn#${site.cdn.fn}`, sk: 'fn' },
        UpdateExpression: 'ADD cacheVersion :one', ExpressionAttributeValues: { ':one': 1 }, ConditionExpression: 'attribute_exists(pk)',
      })).catch((err) => console.error('router cache purge failed', site.cdn.fn, err.name));
    }
    return { purged: paths };
  }

  // ---- routes

  async function owned(domain, who) {
    const site = await getItem(siteKey(cleanDomain(domain) || '-'));
    if (!site || (site.ownerId !== who.userId && !ctx.isStaff(who.role))) return null;
    return site;
  }

  async function routes(event, method, path, who) {
    const { json, error, parseJson } = ctx;
    try {
      if (path === '/domains/sites') {
        if (method === 'GET') {
          const mine = (await ctx.itemsOf(who.userId)).filter((item) => item.kind === 'site');
          return json(200, { sites: mine.map((site) => publicSite(site)), cdnAvailable: cdnOn(), limit: SITE_LIMITS[who.plan || 'launch'] || null });
        }
        if (method === 'POST') {
          const body = parseJson(event);
          const site = await addSite({ domain: body?.domain, ownerId: who.userId, ownerEmail: who.email, plan: who.plan, isStaffCaller: ctx.isStaff(who.role) });
          return json(201, { site: publicSite(await checkDelegation(site)) });
        }
        return error(404, 'not_found');
      }
      const match = path.match(/^\/domains\/sites\/([^/]+)(\/records|\/cdn|\/purge)?$/);
      if (!match) return error(404, 'not_found');
      let site = await owned(decodeURIComponent(match[1]), who);
      if (!site) return error(404, 'That site isn’t in your account.');
      const part = match[2];
      if (!part) {
        if (method === 'GET') {
          site = await advanceCdn(await checkDelegation(site));
          return json(200, { site: publicSite(site, await recordsOf(site)) });
        }
        if (method === 'DELETE') {
          await removeSite(site);
          return json(200, { deleted: true });
        }
        return error(404, 'not_found');
      }
      if (part === '/records') {
        if (method === 'PUT') await putRecord(site, parseJson(event));
        else if (method === 'DELETE') await deleteRecord(site, event.queryStringParameters?.type, event.queryStringParameters?.name);
        else return error(404, 'not_found');
        return json(200, { saved: true });
      }
      if (part === '/cdn' && method === 'PUT') return json(200, { site: publicSite(await setCdn(site, parseJson(event))) });
      if (part === '/purge' && method === 'POST') return json(200, await purge(site, parseJson(event)));
      return error(404, 'not_found');
    } catch (err) {
      if (err instanceof SiteError) return error(err.status, err.message);
      throw err;
    }
  }

  // The scheduled run: name server checks for pending sites, and CDN changes in progress.
  async function tickSite(site) {
    let next = site;
    if (next.status !== 'active') next = await checkDelegation(next);
    if (next.cdn && next.cdn.status !== 'live') next = await advanceCdn(next);
    return next;
  }

  return {
    routes, addSite, tickSite, publicSite, delegationSet, createZone, checkDelegation, advanceCdn, putRecord, deleteRecord, recordsOf, save,
    getSite: (domain) => getItem(siteKey(domain)),
  };
}

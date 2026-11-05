import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  checkoutError,
  cleanDomain,
  contactError,
  fromRecordSet,
  orderAmount,
  pricingConfig,
  pricingError,
  quote,
  recordError,
  recordName,
  retailCents,
  route53RecordSet,
  searchName,
  stripeForm,
  txtValue,
  validStripeSignature,
} from './rules.mjs';
import { alreadyDone, dnaAvailability, dnaContact, dnaDate, DnaError, dnaPriceTable, fromDnaZone, zoneStruct } from './dna.mjs';

const CONTACT = {
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phoneCountry: '+44', phone: '20 7946 0958',
  address1: '1 Analytical Way', city: 'London', zip: 'N1 9GU', country: 'GB',
};

test('domains are cleaned to registrable second-level names', () => {
  assert.equal(cleanDomain(' https://www.Example.COM/path '), 'example.com');
  assert.equal(cleanDomain('my-shop.io'), 'my-shop.io');
  assert.equal(cleanDomain('xn--bcher-kva.com'), 'xn--bcher-kva.com');
  assert.equal(cleanDomain('blog.example.com'), null);
  assert.equal(cleanDomain('-bad.com'), null);
  assert.equal(cleanDomain('ab--cd.com'), null);
  assert.equal(cleanDomain('example'), null);
  assert.equal(searchName('My Shop.com'), 'myshop');
  assert.equal(searchName('...'), null);
});

test('retail price is cost plus commission, rounded up to .99 and never below cost', () => {
  const config = pricingConfig({ percent: 10, flatCents: 0, round99: true });
  assert.equal(retailCents(2200, 'com', config), 2499);
  assert.equal(retailCents(1999, 'com', { ...config, percent: 0 }), 1999);
  assert.equal(retailCents(2000, 'com', { ...config, percent: 0, round99: false }), 2000);
  assert.equal(retailCents(1600, 'io', { ...config, overrides: { io: { percent: 0, flatCents: 250 } } }), 1899);
  assert.equal(retailCents(1600, 'com', { ...config, percent: 0, flatCents: 0, round99: false }), 1600);
});

test('a quote adds DNS hosting to registrations and renewals but not transfers', () => {
  const config = pricingConfig({ percent: 0, flatCents: 0, round99: false, dnsCentsPerYear: 600 });
  const q = quote({ com: { register: 16, renew: 16, transfer: 16 } }, 'com', config);
  assert.deepEqual([q.register, q.renew, q.renewNoDns, q.transfer], [2200, 2200, 1600, 1600]);
  assert.equal(orderAmount(q, 'register', 3), 6600);
  assert.equal(orderAmount(q, 'transfer', 1), 1600);
  assert.equal(orderAmount(q, 'renew', 2), 4400);
  assert.equal(quote({}, 'com', config).register, null);
});

test('pricing updates are validated', () => {
  assert.equal(pricingError({ percent: 12.5, flatCents: 99, tlds: ['com', 'io'] }), null);
  assert.equal(pricingError({ percent: -1 })[0], 400);
  assert.equal(pricingError({ flatCents: 1.5 })[0], 400);
  assert.equal(pricingError({ tlds: ['.com'] })[0], 400);
  assert.equal(pricingError({ tlds: [] })[0], 400);
  assert.equal(pricingError({ overrides: { io: { percent: 900 } } })[0], 400);
});

test('contacts are validated and mapped to DNA', () => {
  assert.equal(contactError(CONTACT), null);
  assert.match(contactError({ ...CONTACT, email: 'nope' })[1], /email/);
  assert.match(contactError({ ...CONTACT, country: 'Britain' })[1], /country/i);
  assert.match(contactError({ ...CONTACT, phone: 'call me' })[1], /digits/);
  assert.match(contactError({ ...CONTACT, city: ' ' })[1], /City/);
  const mapped = dnaContact({ ...CONTACT, organization: 'Engines Ltd', address2: 'Floor 2' });
  assert.deepEqual(mapped, {
    firstName: 'Ada', lastName: 'Lovelace', companyName: 'Engines Ltd', eMail: 'ada@example.com',
    address: '1 Analytical Way, Floor 2', city: 'London', state: 'London', postalCode: 'N1 9GU', country: 'GB',
    phoneCountryCode: '44', phone: '2079460958',
  });
  assert.equal('companyName' in dnaContact(CONTACT), false, 'individuals send no company, or DNA fills in their name');
});

test('the DNA catalogue becomes a yearly USD price table for the account’s price group', () => {
  const entry = (name, extra = {}) => ({
    name, registrationPeriods: [1, 2, 3], renewalPeriods: [1, 2], isPrivacyAvailable: true, attributes: [],
    prices: [
      { priceGroup: 'Platinum', register: [{ period: 1, price: 9, currency: 'USD' }], renew: [{ period: 1, price: 9, currency: 'USD' }], transfer: [] },
      { priceGroup: 'Reseller', register: [{ period: 3, price: 36.57, currency: 'USD' }, { period: 1, price: 11.99, currency: 'USD' }], renew: [{ period: 1, price: 12.29, currency: 'USD' }], transfer: [{ period: 1, price: 11.99, currency: 'USD' }] },
    ],
    ...extra,
  });
  const table = dnaPriceTable([
    entry('com'),
    entry('com.tr', { attributes: [{ key: 'TRABISDOMAINCATEGORY', isRequired: true, type: 'DropdownList' }] }),
    entry('eu', { isTrusteeRequired: true }),
    { name: 'nope', prices: [] },
  ], 'Reseller');
  assert.deepEqual(table.com, { register: 11.99, renew: 12.29, transfer: 11.99, registerYears: [1, 2, 3], renewYears: [1, 2], privacy: true, transferable: true, transferCheck: true, plain: true });
  assert.equal(table['com.tr'].plain, false, 'extensions with required registry fields are not sold');
  assert.equal(table.eu.plain, false);
  assert.equal('nope' in table, false);
  // 1% commission, no .99 rounding, DNS hosting free: $11.99 -> $12.11.
  assert.equal(quote(table, 'com', pricingConfig()).register, 1211);
});

test('DNA search answers, dates, zones and never-retry errors are translated', () => {
  assert.equal(dnaAvailability({ status: 'AVAILABLE' }), 'AVAILABLE');
  assert.equal(dnaAvailability({ status: 'AVAILABLE', isPremium: true }), 'PREMIUM');
  assert.equal(dnaAvailability({ status: 'AVAILABLE', isDocumentRequired: true }), 'DOCUMENTS');
  assert.equal(dnaAvailability({ status: 'NOTAVAILABLE' }), 'UNAVAILABLE');
  assert.equal(dnaAvailability({ status: 'ERROR' }), 'DONT_KNOW');
  assert.equal(dnaAvailability(undefined), 'DONT_KNOW');
  assert.equal(dnaDate('2027-11-05T05:23:33.627'), '2027-11-05T02:23:33.627Z', 'no zone means Turkish time');
  assert.equal(dnaDate('2027-11-05T05:23:33.6275008+03:00'), '2027-11-05T02:23:33.627Z');
  assert.equal(dnaDate('0001-01-01T00:00:00'), null);

  const records = fromDnaZone([
    { name: 'wonder.com.', type: 'SOA', ttl: 3600, records: [{ content: 'tr.domainnameapi.com. hostmaster 1 2 3 4 5' }] },
    { name: 'wonder.com.', type: 'TXT', ttl: 300, records: [{ content: '"v=spf1 -all"' }] },
    { name: 'www.wonder.com.', type: 'CNAME', ttl: 3600, records: [{ content: 'wonder.com.' }] },
    { name: 'old.wonder.com.', type: 'A', ttl: 3600, records: [{ content: '203.0.113.1', disabled: true }] },
  ], 'wonder.com');
  assert.deepEqual(records, [
    { type: 'TXT', name: 'wonder.com', label: '@', values: ['v=spf1 -all'], ttl: 300 },
    { type: 'CNAME', name: 'www.wonder.com', label: 'www', values: ['wonder.com'], ttl: 3600 },
  ]);
  assert.deepEqual(zoneStruct({ type: 'TXT', name: '@', values: ['"v=spf1 -all"'], ttl: 600 }, 'wonder.com'), { name: '@', type: 'TXT', ttl: 600, contents: ['v=spf1 -all'] });
  assert.equal(zoneStruct({ type: 'A', name: 'shop.wonder.com', values: ['203.0.113.9'] }, 'wonder.com').name, 'shop');

  const err = (code, message) => new DnaError(message, { code });
  assert.equal(alreadyDone(err('Dna.DomainService:Domain:10059', 'x')), true);
  assert.equal(alreadyDone(err('Dna.DomainService:Domain:10060', 'x')), true);
  assert.equal(alreadyDone(err('Dna.DomainService:Domain:10058', 'Registry created the domain but it could not be recorded')), true);
  assert.equal(alreadyDone(err('Dna.DomainService:Domain:10058', 'Domain name mixes multiple scripts')), false, 'the harmless meaning of 10058');
  assert.equal(alreadyDone(err('Dna.DomainService:Deposit:10001', 'Insufficient balance')), false);
  assert.equal(alreadyDone(new Error('network')), false);
});

test('checkout requests are validated', () => {
  assert.equal(checkoutError({ action: 'register', domain: 'example.com', years: 2, contact: CONTACT }), null);
  assert.equal(checkoutError({ action: 'renew', domain: 'example.com' }), null);
  assert.match(checkoutError({ action: 'buy', domain: 'example.com' })[1], /Action/);
  assert.match(checkoutError({ action: 'register', domain: 'example.com', years: 9, contact: CONTACT })[1], /Years/);
  assert.match(checkoutError({ action: 'transfer', domain: 'example.com', contact: CONTACT })[1], /EPP/);
  assert.match(checkoutError({ action: 'transfer', domain: 'example.com', years: 2, authCode: 'x', contact: CONTACT })[1], /one year/);
  assert.match(checkoutError({ action: 'register', domain: 'example.com' })[1], /contact/);
});

test('DNS records are validated and round-trip through Route 53 record sets', () => {
  const domain = 'example.com';
  assert.equal(recordName('@', domain), domain);
  assert.equal(recordName('www', domain), 'www.example.com');
  assert.equal(recordName('www.example.com.', domain), 'www.example.com');
  assert.equal(recordError({ type: 'A', name: '@', values: ['203.0.113.10'] }, domain), null);
  assert.match(recordError({ type: 'A', name: '@', values: ['999.1.1.1'] }, domain)[1], /IPv4/);
  assert.match(recordError({ type: 'CNAME', name: '@', values: ['x.example.net'] }, domain)[1], /CNAME/);
  assert.match(recordError({ type: 'MX', name: '@', values: ['mail.example.com'] }, domain)[1], /priority/);
  assert.match(recordError({ type: 'NS', name: '@', values: ['ns1.example.net'] }, domain)[1], /Type/);
  assert.match(recordError({ type: 'A', name: '@', values: ['203.0.113.10'], ttl: 5 }, domain)[1], /TTL/);

  const long = 'v=spf1 '.padEnd(300, 'x');
  assert.equal(txtValue('hello "world"'), '"hello \\"world\\""');
  assert.equal(txtValue(long).split('" "').length, 2);
  const set = route53RecordSet({ type: 'TXT', name: '@', values: [long] }, domain);
  assert.deepEqual(fromRecordSet({ ...set, Name: 'example.com.' }, domain), { type: 'TXT', name: domain, label: '@', values: [long], ttl: 300 });
  assert.equal(fromRecordSet({ Name: 'example.com.', Type: 'NS', ResourceRecords: [] }, domain), null);
  assert.deepEqual(fromRecordSet({ Name: 'www.example.com.', Type: 'CNAME', TTL: 60, ResourceRecords: [{ Value: 'example.com.' }] }, domain).values, ['example.com']);
});

test('Stripe signatures are checked against the raw body, secret and time', () => {
  const body = '{"id":"evt_1"}';
  const t = 1_700_000_000;
  const sign = (secret, at = t, payload = body) => `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`;
  assert.equal(validStripeSignature(body, sign('whsec_a'), 'whsec_a', t), true);
  assert.equal(validStripeSignature(body, `${sign('whsec_b')},v1=${sign('whsec_a').split('v1=')[1]}`, 'whsec_a', t), true);
  assert.equal(validStripeSignature(body, sign('whsec_b'), 'whsec_a', t), false);
  assert.equal(validStripeSignature(`${body} `, sign('whsec_a'), 'whsec_a', t), false);
  assert.equal(validStripeSignature(body, sign('whsec_a', t - 1000), 'whsec_a', t), false);
  assert.equal(validStripeSignature(body, undefined, 'whsec_a', t), false);
  assert.equal(validStripeSignature(body, sign('whsec_a'), undefined, t), false);
});

test('Stripe form encoding nests objects and arrays', () => {
  const form = stripeForm({ mode: 'payment', line_items: [{ quantity: 1, price_data: { unit_amount: 2499 } }], skip: undefined, methods: ['card'] });
  assert.equal(form.toString(), 'mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2499&methods%5B0%5D=card');
});

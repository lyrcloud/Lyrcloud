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
  route53Contact,
  route53RecordSet,
  searchName,
  stripeForm,
  txtValue,
  validStripeSignature,
} from './rules.mjs';

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

test('contacts are validated and mapped to Route 53', () => {
  assert.equal(contactError(CONTACT), null);
  assert.match(contactError({ ...CONTACT, email: 'nope' })[1], /email/);
  assert.match(contactError({ ...CONTACT, country: 'Britain' })[1], /country/i);
  assert.match(contactError({ ...CONTACT, phone: 'call me' })[1], /digits/);
  assert.match(contactError({ ...CONTACT, city: ' ' })[1], /City/);
  const mapped = route53Contact({ ...CONTACT, organization: 'Engines Ltd' });
  assert.equal(mapped.PhoneNumber, '+44.2079460958');
  assert.equal(mapped.ContactType, 'COMPANY');
  assert.equal(mapped.CountryCode, 'GB');
  assert.equal(route53Contact(CONTACT).ContactType, 'PERSON');
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

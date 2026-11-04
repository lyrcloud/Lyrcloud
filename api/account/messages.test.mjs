// Phone number parsing and the email templates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsubscribeToken, updateEmail, updateEmailError, validUnsubscribeToken, welcomeEmail } from './mail.mjs';
import { maskPhone, normalizePhone } from './phone.mjs';

test('mobile numbers are normalised to E.164', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('0044 (20) 7946-0958'), '+442079460958');
  for (const bad of ['9876543210', '+0123456789', '+1 555', 'call me', null, 12345]) assert.equal(normalizePhone(bad), null, String(bad));
  assert.equal(maskPhone('+919876543210'), '+91••••210');
});

test('update emails escape the message and link only https URLs', () => {
  const { html, text } = updateEmail({ subject: 'News', message: '<script>x</script>\n\nSee https://www.lyrcloud.com/blog.', unsubscribeUrl: 'https://api/u' });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /<a href="https:\/\/www\.lyrcloud\.com\/blog"/);
  assert.match(text, /Unsubscribe: https:\/\/api\/u/);
  assert.equal(updateEmailError({ subject: 'x'.repeat(151), message: 'm' })[0], 400);
  assert.equal(updateEmailError({ subject: 's', message: 'm' }), null);
});

test('the welcome email greets by first name', () => {
  assert.equal(welcomeEmail({ name: 'Ada Lovelace' }).subject, 'Welcome to Lyrcloud, Ada');
  assert.equal(welcomeEmail({}).subject, 'Welcome to Lyrcloud');
});

test('unsubscribe tokens are tied to the account', () => {
  const token = unsubscribeToken('secret', 'user-1');
  assert.equal(validUnsubscribeToken('secret', 'user-1', token), true);
  assert.equal(validUnsubscribeToken('secret', 'user-2', token), false);
  assert.equal(validUnsubscribeToken('other', 'user-1', token), false);
});

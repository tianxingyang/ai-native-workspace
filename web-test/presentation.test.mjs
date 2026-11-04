import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresentation, presentation } from '../web/presentation.js';
import catalog from '../web/locales/zh-CN.js';
import { ApiError, errorText } from '../web/client.js';

test('parameters are literal, single-pass text and preserve zero values', () => {
  const view = createPresentation({ locale: 'zh-CN', messages: { sample: '{value} / {count} / {value}' }, formats: {} });
  assert.equal(view.text('sample', { value: '<img src=x onerror=alert(1)>{count}', count: 0 }),
    '<img src=x onerror=alert(1)>{count} / 0 / <img src=x onerror=alert(1)>{count}');
});

test('unknown keys and missing or inherited parameters fail explicitly', () => {
  assert.throws(() => presentation.text('toString'), /Unknown presentation key/);
  assert.throws(() => presentation.text('duration.hoursMinutes', { hours: 1 }), /Missing presentation parameter: minutes/);
  assert.throws(() => presentation.text('duration.minutes', Object.create({ minutes: 10 })), /Missing presentation parameter/);
  assert.throws(() => presentation.format('toString', Date.now()), /Unknown presentation format/);
});

test('existing demo date and time formats preserve previous Date helper output', () => {
  const date = new Date('2026-11-04T10:05:09Z');
  assert.equal(presentation.format('time', date), date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  assert.equal(presentation.format('timeSeconds', date), date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  assert.equal(presentation.format('dateTime', date), date.toLocaleString('zh-CN'));
  assert.equal(presentation.format('day', date), date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }));
  assert.equal(presentation.format('compactDate', date), date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
});

test('date formatting follows the supplied catalog locale, not a hardcoded demo locale', () => {
  // Test-only catalogs, not additional supported product languages.
  const formats = { date: { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' } };
  const english = createPresentation({ locale: 'en-GB', messages: {}, formats });
  const chinese = createPresentation({ locale: 'zh-CN', messages: {}, formats });
  const timestamp = Date.UTC(2026, 10, 4);
  assert.equal(english.format('date', timestamp), '04/11/2026');
  assert.equal(chinese.format('date', timestamp), '2026/11/04');
});

test('transport errors select safe catalog messages without exposing remote details', () => {
  const secret = 'private-server-detail-not-for-display';
  assert.equal(errorText(new ApiError(401, 'demo_expired')), catalog.messages['error.demoExpired']);
  assert.equal(errorText(new ApiError(401, 'credential_expired')), catalog.messages['error.credentialExpired']);
  for (const status of [401, 403, 409, 429, 500, 507]) {
    const message = errorText(new ApiError(status, secret));
    assert.equal(message.includes(secret), false); assert.ok(message.length > 0);
  }
  assert.equal(errorText(new ApiError(503, secret)), '服务暂时无法处理请求（503），请重试。');
  assert.equal(errorText(new Error(secret)), catalog.messages['error.connection']);
});

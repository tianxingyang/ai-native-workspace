import { createHash } from 'node:crypto';
import { objectValue, requireCondition, type TextAttachment } from '../contracts.js';

export function textAttachment(value: unknown): { metadata: TextAttachment; text: string } {
  const input = objectValue(value), { name, text } = input;
  requireCondition(Object.keys(input).every(key => key === 'name' || key === 'text'), 400, 'invalid_attachment');
  requireCondition(typeof name === 'string' && name.length <= 120 && name.trim() === name
    && /\S\.(txt|md)$/i.test(name) && !/[\\/\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(name)
    && !/\p{Surrogate}/u.test(name), 400, 'invalid_attachment_name');
  requireCondition(typeof text === 'string' && text.length > 0 && !/\p{Surrogate}/u.test(text)
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text), 400, 'invalid_attachment_text');
  const bytes = Buffer.byteLength(text, 'utf8');
  requireCondition(bytes <= 8192, 413, 'attachment_too_large');
  return { metadata: { name, bytes, sha256: createHash('sha256').update(text).digest('hex') }, text };
}

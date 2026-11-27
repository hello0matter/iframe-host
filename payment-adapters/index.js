const { normalizeGeneric } = require('./generic');
const { normalizeXpPay } = require('./xp-pay');
const { normalizeVmq } = require('./vmq');

const ADAPTERS = { generic: normalizeGeneric, xp_pay: normalizeXpPay, vmq: normalizeVmq };

function parseAmount(value) {
  const text = String(value ?? '').trim().replace(/[,¥￥\s]/g, '');
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/.test(text)) throw new Error('payment: invalid amount');
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error('payment: invalid amount');
  return amount.toFixed(2);
}

function parseExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100000000000 ? Math.round(value * 1000) : Math.round(value);
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return n < 100000000000 ? n * 1000 : n;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePaymentIntent(input, site) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const adapterName = String(source.adapter || site.payment?.adapter || 'generic').replaceAll('-', '_');
  const adapter = ADAPTERS[adapterName] || ADAPTERS.generic;
  const value = adapter(source, site);
  const orderRef = String(value.order_ref || '').trim();
  if (!/^[A-Za-z0-9_.:@/-]{1,160}$/.test(orderRef)) throw new Error('payment: order reference is required');
  const amount = parseAmount(value.amount);
  const kind = ['qr', 'redirect', 'purchase'].includes(value.kind) ? value.kind : 'purchase';
  const provider = String(value.provider || adapterName).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'generic';
  const channel = String(value.channel || 'alipay').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'alipay';
  const currency = String(value.currency || 'CNY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'CNY';
  const qrContent = String(value.qr_content || '').trim();
  if (qrContent.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(qrContent)) throw new Error('payment: invalid QR content');
  const qrImageUrl = String(value.qr_image_url || '').trim();
  if (qrImageUrl && !/^https?:\/\//i.test(qrImageUrl)) throw new Error('payment: QR image must be HTTP(S)');
  const payUrl = String(value.pay_url || '').trim();
  if (payUrl && !/^https?:\/\//i.test(payUrl)) throw new Error('payment: pay URL must be HTTP(S)');
  if (kind === 'qr' && !qrContent && !qrImageUrl && !payUrl) throw new Error('payment: QR intent requires content or a pay URL');
  const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {};
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16384) throw new Error('payment: metadata is too large');
  return {
    provider,
    adapter: adapterName,
    kind,
    order_ref: orderRef,
    amount,
    currency,
    channel,
    qr_content: qrContent,
    qr_image_url: qrImageUrl,
    pay_url: payUrl,
    expires_at: parseExpiresAt(value.expires_at),
    settle: ['notification_listener', 'poll_upstream', 'manual'].includes(value.settle) ? value.settle : 'notification_listener',
    metadata,
  };
}

module.exports = { ADAPTERS, normalizePaymentIntent, parseAmount, parseExpiresAt };

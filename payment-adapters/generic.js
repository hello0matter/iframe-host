function normalizeGeneric(input, site) {
  const source = input && typeof input === 'object' ? input : {};
  const order = source.order && typeof source.order === 'object' ? source.order : source;
  return {
    provider: source.provider || site.payment?.adapter || 'generic',
    kind: source.kind || (source.qr_content || source.qr_url ? 'qr' : source.pay_url ? 'redirect' : 'purchase'),
    order_ref: source.order_ref || source.order_id || order.out_trade_no || order.order_id || '',
    amount: source.amount ?? order.pay_amount ?? order.amount ?? order.reallyPrice,
    currency: source.currency || order.currency || 'CNY',
    channel: source.channel || order.payment_type || order.channel || 'alipay',
    qr_content: source.qr_content || source.qr_url || order.qr_code || order.qrCode || order.qrcode || '',
    qr_image_url: source.qr_image_url || order.qr_image_url || '',
    pay_url: source.pay_url || order.pay_url || order.payUrl || '',
    expires_at: source.expires_at || order.expires_at || order.expire_time || '',
    settle: source.settle || 'notification_listener',
    metadata: source.metadata || {},
  };
}

module.exports = { normalizeGeneric };

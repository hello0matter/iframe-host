function normalizeXpPay(input, site) {
  const source = input && typeof input === 'object' ? input : {};
  const order = source.order && typeof source.order === 'object' ? source.order : source.data && typeof source.data === 'object' ? source.data : source;
  const payUrl = order.pay_url || order.payUrl || '';
  const qr = order.qr_code || order.qrCode || order.qrcode || order.qr_content || '';
  const scheme = order.scheme || '';
  const metadata = {
    order_id: order.order_id || order.id || '',
    out_trade_no: order.out_trade_no || '',
    payment_mode: order.payment_mode || '',
    result_type: order.result_type || '',
    scheme,
  };
  const qrContent = source.qr_content || qr || payUrl;
  return {
    provider: 'xp_pay',
    kind: qrContent || payUrl ? 'qr' : 'purchase',
    order_ref: source.order_ref || order.out_trade_no || order.order_id || order.orderId || order.id || '',
    amount: source.amount ?? order.pay_amount ?? order.trade_amount ?? order.amount ?? order.reallyPrice,
    currency: source.currency || order.currency || 'CNY',
    channel: source.channel || order.payment_type || order.pay_type || order.channel || 'alipay',
    qr_content: qrContent,
    qr_image_url: source.qr_image_url || order.qr_image_url || '',
    pay_url: source.pay_url || payUrl,
    expires_at: source.expires_at || order.expires_at || order.expire_time || '',
    settle: source.settle || 'notification_listener',
    metadata: { ...metadata, ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) },
    adapter: 'xp_pay',
  };
}

module.exports = { normalizeXpPay };

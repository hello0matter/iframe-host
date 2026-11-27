function normalizeVmq(input, site) {
  const source = input && typeof input === 'object' ? input : {};
  const order = source.order && typeof source.order === 'object' ? source.order : source.data && typeof source.data === 'object' ? source.data : source;
  const payUrl = source.pay_url || order.payUrl || order.pay_url || '';
  const qrContent = source.qr_content || order.qrCodeContent || order.qr_content || payUrl;
  return {
    provider: 'vmq',
    kind: qrContent || payUrl ? 'qr' : 'purchase',
    order_ref: source.order_ref || order.orderId || order.order_id || order.payId || order.pay_id || '',
    amount: source.amount ?? order.reallyPrice ?? order.price ?? order.amount,
    currency: source.currency || order.currency || 'CNY',
    channel: source.channel || (order.type === '2' || order.type === 2 ? 'wxpay' : order.channel || 'alipay'),
    qr_content: qrContent,
    qr_image_url: source.qr_image_url || order.qrImageUrl || order.qr_image_url || '',
    pay_url: payUrl,
    expires_at: source.expires_at || order.expires_at || order.expiresAt || '',
    settle: source.settle || 'notification_listener',
    metadata: { pay_id: order.payId || order.pay_id || '', order_id: order.orderId || order.order_id || '', access_token_present: Boolean(order.accessToken), ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) },
    adapter: 'vmq',
  };
}

module.exports = { normalizeVmq };

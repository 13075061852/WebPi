export function videoBalanceText(value) {
  if (!value?.available || !Number.isFinite(value.amount)) return value?.message || '查询失败';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value.amount)} ${value.unit === 'Credits' ? '积分' : value.unit}`;
}

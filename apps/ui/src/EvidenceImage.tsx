import { useState } from 'react';
import type { ArtifactAvailability } from '@interaction/browser';

export const evidenceStatusText: Record<ArtifactAvailability['status'], string> = {
  available: '可读取', not_captured: '未采集', not_retained: '未留存', expired: '已过期', evicted: '已被容量策略淘汰', released: '已释放', storage_failed: '存储读取失败', missing: '文件缺失',
};

/** Availability is advisory: the artifact can expire between metadata and image requests. */
export function EvidenceImage({ src, alt, availability }: { src: string; alt: string; availability?: ArtifactAvailability }) {
  const [failed, setFailed] = useState<string>();
  if (availability && availability.status !== 'available') return <p role="status">{alt}：{evidenceStatusText[availability.status]}。{availability.reason}</p>;
  if (failed === src) return <p role="status">{alt}读取失败，可能已过期或被清理。历史控件属性仍可查看，请刷新详情确认留存状态。</p>;
  return <img src={src} alt={alt} onError={() => setFailed(src)} />;
}

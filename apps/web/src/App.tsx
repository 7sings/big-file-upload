import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent, ReactNode, TouchEvent } from 'react';
import { ACCEPT_ATTRIBUTE } from '@big-upload/shared';
import type { CurrentUser, FileRecord } from '@big-upload/shared';
import { api, ApiError, unwrapUser } from './api/client';
import { UploadManager } from './features/upload-manager';
import type { UploadView } from './types';

const statusText: Record<string, string> = {
  HASHING: '计算指纹', PREPARING: '准备上传', UPLOADING: '上传中', PAUSED: '已暂停', WAITING_NETWORK: '等待网络', COMPLETING: '合并分片', VERIFYING: '安全校验', SUCCEEDED: '已完成', FAILED_RETRYABLE: '可重试', FAILED_FINAL: '上传失败', CANCELED: '已取消',
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分`;
}
function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined || milliseconds < 0) return '—';
  const seconds = Math.ceil(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function formatDate(value: number) {
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

type MobileFileKind = 'video' | 'image' | 'audio' | 'pdf' | 'txt';
type IconName = 'search' | 'close' | 'computer' | 'files' | 'video' | 'image' | 'audio' | 'pdf' | 'txt' | 'more' | 'trash' | 'download' | 'arrow' | 'warning' | 'logout' | 'refresh' | 'play' | 'pause';
const previewUrlCache = new Map<string, { url?: string; expiresAt: number; promise?: Promise<string> }>();

function readCachedPreviewUrl(fileId: string) {
  const cached = previewUrlCache.get(fileId);
  if (cached?.url && cached.expiresAt > Date.now()) return cached.url;
  if (cached?.url) previewUrlCache.delete(fileId);
  return '';
}

function getPreviewUrl(fileId: string) {
  const cached = previewUrlCache.get(fileId);
  if (cached?.promise) return cached.promise;
  const cachedUrl = readCachedPreviewUrl(fileId);
  if (cachedUrl) return Promise.resolve(cachedUrl);
  const promise = api.preview(fileId).then((ticket) => {
    const rawExpiry = ticket.expiresAt ? (ticket.expiresAt < 10_000_000_000 ? ticket.expiresAt * 1000 : ticket.expiresAt) : Date.now() + 60_000;
    previewUrlCache.set(fileId, { url: ticket.url, expiresAt: Math.max(Date.now() + 1_000, rawExpiry - 10_000) });
    return ticket.url;
  }).catch((error) => { previewUrlCache.delete(fileId); throw error; });
  previewUrlCache.set(fileId, { expiresAt: Number.POSITIVE_INFINITY, promise });
  return promise;
}

function fileKind(file: FileRecord): MobileFileKind {
  if (file.detectedMime.startsWith('video/')) return 'video';
  if (file.detectedMime.startsWith('image/')) return 'image';
  if (file.detectedMime.startsWith('audio/')) return 'audio';
  if (file.detectedMime === 'application/pdf') return 'pdf';
  return 'txt';
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    files: <><path d="M15 2H6a2 2 0 0 0-2 2v13" /><path d="M8 6h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" /></>,
    video: <><rect x="3" y="5" width="15" height="14" rx="3" /><path d="m18 10 3-2v8l-3-2" /><path d="m9.5 9 4 3-4 3Z" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></>,
    audio: <><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></>,
    pdf: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5M9 13h6m-6 4h4" /></>,
    txt: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5M9 12h6m-6 4h6" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    trash: <><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m3 0-1 14H7L6 7" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 21h14" /></>,
    arrow: <><path d="m9 18 6-6-6-6" /></>,
    warning: <><path d="M10.3 3.8 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    logout: <><path d="M10 5H5v14h5m5-3 4-4-4-4m4 4H9" /></>,
    refresh: <><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 11m2 4a7 7 0 0 0 12 2l2-4" /></>,
    play: <path d="m9 6 9 6-9 6Z" />,
    pause: <><path d="M9 6v12m6-12v12" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width: 720px)'); const update = () => setMobile(query.matches); update(); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  return mobile;
}
function formatNetworkEstimate() {
  const connection = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  return connection?.downlink && connection.downlink > 0 ? `网络估算 ${connection.downlink} Mbps` : null;
}

function Login({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => { if (!cooldown) return; const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, [cooldown]);
  async function requestCode(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api.requestOtp({ email: email.trim() }); setChallengeId(result.challengeId); setCooldown(result.resendAfter ?? 60); }
    catch (reason) { if (reason instanceof ApiError && reason.retryAfterSeconds) setCooldown(reason.retryAfterSeconds); setError(reason instanceof Error ? reason.message : '验证码发送失败'); }
    finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError('');
    try { const result = await api.requestOtp({ email: email.trim() }); setChallengeId(result.challengeId); setCode(''); setCooldown(result.resendAfter ?? 60); }
    catch (reason) { if (reason instanceof ApiError && reason.retryAfterSeconds) setCooldown(reason.retryAfterSeconds); setError(reason instanceof Error ? reason.message : '验证码发送失败'); }
    finally { setBusy(false); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin(unwrapUser(await api.verifyOtp({ challengeId, code }))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setBusy(false); }
  }

  return <main className="login-shell">
    <section className="login-copy"><div className="brand"><span className="brand-mark">R</span><span>Rock File</span></div><p className="eyebrow">大文件传输基础设施</p><h1>把超大文件，<br />稳稳送达。</h1><p className="hero-note">分片直传、断点恢复与浏览器端指纹计算，面向真实网络环境设计。</p><div className="feature-line"><span>01</span> 动态并发与智能重试</div><div className="feature-line"><span>02</span> 关闭页面后仍可恢复</div><div className="feature-line"><span>03</span> 内容校验与安全预览</div></section>
    <section className="login-panel"><div className="login-card"><p className="eyebrow">安全登录</p><h2>{challengeId ? '输入邮箱验证码' : '登录上传工作台'}</h2><p className="muted">{challengeId ? `验证码已发送至 ${email}` : '使用邮箱验证码确认身份，无需记住密码。'}</p>
      {!challengeId ? <form onSubmit={requestCode}><label>邮箱地址<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label><button className="primary wide" disabled={busy}>{busy ? '发送中…' : '获取验证码'}</button></form>
      : <form onSubmit={verify}><label>6 位验证码<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /></label><button className="primary wide" disabled={busy || code.length !== 6}>{busy ? '验证中…' : '进入工作台'}</button><button type="button" className="text-button" disabled={busy || cooldown > 0} onClick={() => void resend()}>{cooldown ? `${cooldown} 秒后可重新发送` : '重新发送验证码'}</button></form>}
      {error && <div className="error-banner" role="alert">{error}</div>}<p className="legal">继续即表示你同意仅上传拥有合法权限的内容。</p></div></section>
  </main>;
}

function UploadElapsed({ item }: { item: UploadView }) {
  const [timestamp, setTimestamp] = useState(() => Date.now());
  useEffect(() => {
    if (!item.elapsedStartedAt) return;
    setTimestamp(Date.now());
    const timer = window.setInterval(() => setTimestamp(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [item.elapsedStartedAt]);
  const elapsed = (item.elapsedMs ?? 0) + (item.elapsedStartedAt ? Math.max(0, timestamp - item.elapsedStartedAt) : 0);
  return <span>总耗时 {formatDuration(elapsed)}</span>;
}

function UploadRow({ item, manager }: { item: UploadView; manager: UploadManager }) {
  const ratio = item.fileSize ? Math.min(1, item.uploadedBytes / item.fileSize) : 0;
  const resumable = ['PAUSED', 'WAITING_NETWORK', 'FAILED_RETRYABLE'].includes(item.status);
  const pausable = ['HASHING', 'PREPARING', 'UPLOADING'].includes(item.status);
  const terminal = ['SUCCEEDED', 'FAILED_FINAL', 'CANCELED'].includes(item.status);
  return <article className="upload-row">
    <div className={`file-glyph ${item.fileType.split('/')[0]}`}><span>{item.fileName.split('.').pop()?.slice(0, 4).toUpperCase()}</span></div>
    <div className="upload-main"><div className="row-top"><div><strong title={item.fileName}>{item.fileName}</strong><span>{formatBytes(item.fileSize)} · {statusText[item.status] ?? item.status}{item.needsFile ? ' · 需重新选择原文件' : ''}</span></div><b>{Math.round(ratio * 100)}%</b></div>
      <div className="progress"><i style={{ width: `${ratio * 100}%` }} /></div>
      <div className="upload-meta"><span>{item.status === 'UPLOADING' ? `实时速率 ${formatBytes(item.speed)}/s` : statusText[item.status]}</span>{formatNetworkEstimate() && <span>{formatNetworkEstimate()}</span>}<span>剩余 {formatEta(item.etaSeconds)}</span>{item.partSize && <span>固定分片 {formatBytes(item.partSize)}</span>}<span>{item.uploadedParts.length}/{item.totalParts || '—'} 分片</span><UploadElapsed item={item} /></div>
      {item.error && <p className="inline-error">{item.error}</p>}
    </div>
    <div className="row-actions">{pausable && <button onClick={() => manager.pause(item.localId)}>暂停</button>}{resumable && <button onClick={() => manager.resume(item.localId)}>{item.needsFile ? '选择原文件' : '继续'}</button>}{!terminal && <button className="danger-link" onClick={() => void manager.cancel(item.localId)}>取消</button>}{terminal && <button onClick={() => void manager.remove(item.localId)}>移除</button>}</div>
  </article>;
}

function PreviewModal({ file, previousFile, nextFile, onClose, onPrevious, onNext }: { file: FileRecord; previousFile?: FileRecord; nextFile?: FileRecord; onClose: () => void; onPrevious?: () => void; onNext?: () => void }) {
  const [url, setUrl] = useState(''); const [text, setText] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (file.detectedMime === 'text/plain') {
          const result = await api.text(file.id);
          if (!cancelled) setText(result.content);
          return;
        }
        const previewUrl = await getPreviewUrl(file.id);
        if (!previewUrl) throw new Error('服务器未返回预览地址');
        if (!cancelled) setUrl(previewUrl);
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : '无法预览'); }
    })();
    return () => { cancelled = true; };
  }, [file]);
  const mime = file.detectedMime;
  const image = mime.startsWith('image/');
  useEffect(() => {
    if (!image) return;
    const adjacent = [previousFile, nextFile].filter((value): value is FileRecord => Boolean(value));
    if (adjacent.length) void Promise.allSettled(adjacent.map((value) => getPreviewUrl(value.id)));
  }, [image, nextFile?.id, previousFile?.id]);
  useEffect(() => {
    if (!image) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && onPrevious) onPrevious();
      if (event.key === 'ArrowRight' && onNext) onNext();
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [image, onClose, onNext, onPrevious]);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`${file.originalName} 预览`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="preview-modal"><header><div><p className="eyebrow">安全预览</p><h3>{file.originalName}</h3></div><button className="close" onClick={onClose} aria-label="关闭">×</button></header><div className="preview-stage">{error ? <div className="empty-state">{error}</div> : !url && !text ? <div className="loader">加载预览中…</div> : image ? <img src={url} alt={file.originalName} /> : mime.startsWith('video/') ? <video src={url} controls /> : mime.startsWith('audio/') ? <audio src={url} controls /> : mime === 'application/pdf' ? <iframe src={url} title={file.originalName} /> : <pre>{text}</pre>}{image && <><button className="preview-nav previous" disabled={!onPrevious} onClick={onPrevious} aria-label="上一张"><Icon name="arrow" size={26} /></button><button className="preview-nav next" disabled={!onNext} onClick={onNext} aria-label="下一张"><Icon name="arrow" size={26} /></button></>}</div></div></div>;
}

function DesktopFileThumbnail({ file }: { file: FileRecord }) {
  const kind = fileKind(file);
  const [url, setUrl] = useState('');
  const target = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (kind !== 'image') return;
    let active = true;
    const load = () => void getPreviewUrl(file.id).then((previewUrl) => { if (active) setUrl(previewUrl); }).catch(() => undefined);
    if (!('IntersectionObserver' in window)) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '280px 0px' });
    if (target.current) observer.observe(target.current);
    return () => { active = false; observer.disconnect(); };
  }, [file.id, kind]);
  return <div ref={target} className={`file-cover ${kind}`}>{url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <span>{file.originalName.split('.').pop()?.slice(0, 4).toUpperCase()}</span>}</div>;
}

function FileThumbnail({ file }: { file: FileRecord }) {
  const kind = fileKind(file);
  const [url, setUrl] = useState('');
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (kind !== 'image') return;
    let active = true;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void getPreviewUrl(file.id).then((previewUrl) => { if (active) setUrl(previewUrl); }).catch(() => undefined);
    };
    if (!('IntersectionObserver' in window)) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '240px 0px' });
    if (target.current) observer.observe(target.current);
    return () => { active = false; observer.disconnect(); };
  }, [file.id, kind]);
  if (url) return <img ref={(element) => { target.current = element; }} className="mobile-file-thumb-image" src={url} alt="" loading="lazy" decoding="async" />;
  return <div ref={(element) => { target.current = element; }} className={`mobile-file-thumb ${kind}`}><Icon name={kind} size={23} /></div>;
}

function MobileDocumentPreview({ file, previousFile, nextFile, onClose, onPrevious, onNext }: { file: FileRecord; previousFile?: FileRecord; nextFile?: FileRecord; onClose: () => void; onPrevious?: () => void; onNext?: () => void }) {
  const [url, setUrl] = useState('');
  const [urlFileId, setUrlFileId] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [swipeTransitioning, setSwipeTransitioning] = useState(false);
  const [, setAdjacentRevision] = useState(0);
  const touchStart = useRef<{ x: number; y: number; time: number; horizontal: boolean } | null>(null);
  const currentSwipeOffset = useRef(0);
  const kind = fileKind(file);
  useEffect(() => {
    let active = true;
    setContent(''); setError('');
    const load = kind === 'txt' ? api.text(file.id).then((value) => { if (active) setContent(value.content); }) : getPreviewUrl(file.id).then((previewUrl) => { if (active) { setUrl(previewUrl); setUrlFileId(file.id); } });
    void load.catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '无法加载预览'); });
    return () => { active = false; };
  }, [file.id, kind]);
  useEffect(() => {
    if (kind !== 'image') return;
    let active = true;
    const preloads = [previousFile, nextFile].filter((value): value is FileRecord => Boolean(value)).map((value) => getPreviewUrl(value.id));
    if (preloads.length) void Promise.allSettled(preloads).then(() => { if (active) setAdjacentRevision((value) => value + 1); });
    return () => { active = false; };
  }, [kind, nextFile?.id, previousFile?.id]);
  useEffect(() => {
    if (kind !== 'image') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && onPrevious) onPrevious();
      if (event.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [kind, onNext, onPrevious]);
  const showImageNavigation = kind === 'image' && Boolean(onPrevious || onNext);
  const displayedUrl = urlFileId === file.id ? url : readCachedPreviewUrl(file.id);
  const previousUrl = previousFile ? readCachedPreviewUrl(previousFile.id) : '';
  const nextUrl = nextFile ? readCachedPreviewUrl(nextFile.id) : '';
  function onImageTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (kind !== 'image' || event.touches.length !== 1 || swipeTransitioning) return;
    const touch = event.touches[0]!;
    touchStart.current = { x: touch.clientX, y: touch.clientY, time: performance.now(), horizontal: false };
    currentSwipeOffset.current = 0; setSwiping(true); setSwipeOffset(0);
  }
  function onImageTouchMove(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    if (!start || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (!start.horizontal && Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 8) {
      if (Math.abs(deltaY) >= Math.abs(deltaX)) { touchStart.current = null; setSwiping(false); return; }
      start.horizontal = true;
    }
    if (!start.horizontal) return;
    const atBoundary = (deltaX > 0 && (!onPrevious || !previousUrl)) || (deltaX < 0 && (!onNext || !nextUrl));
    const nextOffset = atBoundary ? deltaX * .22 : deltaX;
    currentSwipeOffset.current = nextOffset; setSwipeOffset(nextOffset);
  }
  function finishImageTouch() {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !start.horizontal) { setSwiping(false); setSwipeOffset(0); return; }
    const elapsed = Math.max(1, performance.now() - start.time);
    const offset = currentSwipeOffset.current;
    const fastEnough = Math.abs(offset) > 24 && Math.abs(offset) / elapsed > .42;
    const farEnough = Math.abs(offset) > 56;
    const destination = offset < 0 ? (nextUrl ? onNext : undefined) : (previousUrl ? onPrevious : undefined);
    if ((fastEnough || farEnough) && destination) {
      const exitOffset = offset < 0 ? -window.innerWidth : window.innerWidth;
      currentSwipeOffset.current = exitOffset; setSwiping(false); setSwipeTransitioning(true); setSwipeOffset(exitOffset);
      window.setTimeout(() => { destination(); currentSwipeOffset.current = 0; setSwipeTransitioning(false); setSwipeOffset(0); }, 150);
      return;
    }
    currentSwipeOffset.current = 0; setSwiping(false); setSwipeTransitioning(true); setSwipeOffset(0);
    window.setTimeout(() => setSwipeTransitioning(false), 180);
  }
  return <div className={`mobile-preview ${kind}`} role="dialog" aria-modal="true" aria-label={`${file.originalName} 预览`}>
    <header><button onClick={onClose} aria-label="关闭预览"><Icon name="close" /></button><strong>{file.originalName}</strong><a href={api.downloadUrl(file.id)} download={file.originalName} aria-label="下载文件"><Icon name="download" /></a></header>
    <div className="mobile-preview-stage" onTouchStart={onImageTouchStart} onTouchMove={onImageTouchMove} onTouchEnd={finishImageTouch} onTouchCancel={finishImageTouch}>
      {error ? <div className="mobile-preview-message">{error}</div> : kind === 'txt' ? (content ? <pre>{content}</pre> : <div className="mobile-preview-message">正在读取文档…</div>) : !displayedUrl ? <div className="mobile-preview-message">正在加载预览…</div> : kind === 'image' ? <div className="mobile-image-carousel">
        {previousFile && previousUrl && <div className={`mobile-image-slide previous ${swiping ? 'is-swiping' : ''} ${swipeTransitioning ? 'is-transitioning' : ''}`} style={{ transform: `translate3d(calc(-100% + ${swipeOffset}px), 0, 0)` }}><img src={previousUrl} alt={previousFile.originalName} draggable={false} /></div>}
        <div className={`mobile-image-slide current ${swiping ? 'is-swiping' : ''} ${swipeTransitioning ? 'is-transitioning' : ''}`} style={{ transform: `translate3d(${swipeOffset}px, 0, 0)` }}><img src={displayedUrl} alt={file.originalName} draggable={false} /></div>
        {nextFile && nextUrl && <div className={`mobile-image-slide next ${swiping ? 'is-swiping' : ''} ${swipeTransitioning ? 'is-transitioning' : ''}`} style={{ transform: `translate3d(calc(100% + ${swipeOffset}px), 0, 0)` }}><img src={nextUrl} alt={nextFile.originalName} draggable={false} /></div>}
      </div> : kind === 'video' ? <video src={displayedUrl} controls autoPlay playsInline /> : <iframe src={displayedUrl} title={file.originalName} />}
      {showImageNavigation && <><button className="mobile-preview-nav previous" disabled={!onPrevious || !previousUrl} onClick={onPrevious} aria-label="上一张"><Icon name="arrow" size={24} /></button><button className="mobile-preview-nav next" disabled={!onNext || !nextUrl} onClick={onNext} aria-label="下一张"><Icon name="arrow" size={24} /></button></>}
      {showImageNavigation && <span className="mobile-swipe-hint">左右滑动切换</span>}
    </div>
  </div>;
}

function MobileAudioPlayer({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => { let active = true; void getPreviewUrl(file.id).then((previewUrl) => { if (active) setUrl(previewUrl); }).catch(() => undefined); return () => { active = false; }; }, [file.id]);
  function toggle() { const element = audio.current; if (!element) return; if (element.paused) void element.play(); else element.pause(); }
  return <div className="mobile-audio-player" role="region" aria-label={`${file.originalName} 音频播放器`}>
    <audio ref={audio} src={url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    <button className="audio-play" onClick={toggle} disabled={!url} aria-label={playing ? '暂停' : '播放'}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
    <div><strong>{file.originalName}</strong><span>{url ? (playing ? '正在播放' : '轻触继续播放') : '正在载入音频…'}</span></div>
    <button className="audio-close" onClick={onClose} aria-label="关闭播放器"><Icon name="close" size={18} /></button>
  </div>;
}

function DeleteSheet({ file, busy, onCancel, onConfirm }: { file: FileRecord; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setArmed(true), 300); return () => clearTimeout(timer); }, []);
  return <div className="mobile-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="mobile-action-sheet" role="dialog" aria-modal="true" aria-labelledby="delete-sheet-title">
      <div className="sheet-handle" />
      <div className="sheet-warning"><Icon name="warning" size={25} /></div>
      <h2 id="delete-sheet-title">彻底删除文件？</h2>
      <p className="sheet-file-name">{file.originalName}</p>
      <p className="sheet-copy">此文件将从云端永久移除，此操作无法撤销。</p>
      <button className="sheet-delete" disabled={!armed || busy} onClick={onConfirm}><Icon name="trash" size={18} />{busy ? '正在删除…' : '确认删除'}</button>
      <button className="sheet-cancel" disabled={busy} onClick={onCancel}>取消</button>
    </section>
  </div>;
}

function DesktopDeleteDialog({ file, busy, onCancel, onConfirm }: { file: FileRecord; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-delete-title">
      <div className="delete-dialog-icon"><Icon name="trash" size={24} /></div>
      <p className="eyebrow">危险操作</p>
      <h2 id="desktop-delete-title">删除这个文件？</h2>
      <p><strong>{file.originalName}</strong> 将从云端永久移除，无法恢复。</p>
      <div className="delete-dialog-actions"><button disabled={busy} onClick={onCancel}>取消</button><button className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '确认删除'}</button></div>
    </section>
  </div>;
}

const mobileFilters: Array<{ value: 'all' | MobileFileKind; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'video', label: '视频' }, { value: 'image', label: '图片' }, { value: 'audio', label: '音频' }, { value: 'pdf', label: 'PDF' }, { value: 'txt', label: '文档' },
];

function MobileWorkbench({ user, files, notice, onNotice, onRefresh, onLogout, onFilesChange }: { user: CurrentUser; files: FileRecord[]; notice: string; onNotice: (value: string) => void; onRefresh: () => Promise<void>; onLogout: () => void; onFilesChange: (files: FileRecord[]) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | MobileFileKind>('all');
  const [preview, setPreview] = useState<FileRecord | null>(null);
  const [audioFile, setAudioFile] = useState<FileRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const totalSize = files.reduce((sum, file) => sum + file.byteSize, 0);
  const visibleFiles = files.filter((file) => (filter === 'all' || fileKind(file) === filter) && file.originalName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visibleImages = visibleFiles.filter((file) => fileKind(file) === 'image');
  const previewImageIndex = preview && fileKind(preview) === 'image' ? visibleImages.findIndex((file) => file.id === preview.id) : -1;
  function openFile(file: FileRecord) { if (fileKind(file) === 'audio') setAudioFile(file); else setPreview(file); }
  async function removeFile() {
    if (!deleteTarget) return;
    setDeleting(true);
    try { await api.deleteFile(deleteTarget.id); previewUrlCache.delete(deleteTarget.id); onFilesChange(files.filter((file) => file.id !== deleteTarget.id)); if (audioFile?.id === deleteTarget.id) setAudioFile(null); setDeleteTarget(null); onNotice('文件已删除'); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : '删除失败，请稍后重试'); }
    finally { setDeleting(false); }
  }
  return <div className="mobile-shell">
    <header className="mobile-header">
      <div className="mobile-title-row"><div><span className="mobile-brand-mark">R</span><div><strong>文件仓库</strong><span>{user.email}</span></div></div><div><button onClick={() => void onRefresh()} aria-label="刷新文件"><Icon name="refresh" /></button><button onClick={onLogout} aria-label="退出登录"><Icon name="logout" /></button></div></div>
      <label className="mobile-search"><Icon name="search" size={19} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索你的文件" aria-label="搜索文件" />{query && <button onClick={() => setQuery('')} aria-label="清空搜索"><Icon name="close" size={16} /></button>}</label>
    </header>
    <main className="mobile-content">
      <section className="mobile-bento" aria-label="文件概览">
        <article className="storage-card"><div className="bento-icon"><Icon name="files" /></div><strong>{files.length}<small> 个文件</small></strong><span>{formatBytes(totalSize)} 已用</span><i><b style={{ width: `${Math.min(100, Math.max(8, totalSize / (50 * 1024 ** 3) * 100))}%` }} /></i></article>
        <article className="pc-notice"><div className="bento-icon"><Icon name="computer" /></div><strong>需要上传？</strong><span>请使用 PC 端访问</span><em>桌面端支持大文件分片上传</em></article>
      </section>
      {notice && <div className="mobile-notice" role="status"><span>{notice}</span><button onClick={() => onNotice('')}><Icon name="close" size={16} /></button></div>}
      <nav className="mobile-filters" aria-label="文件类型筛选">{mobileFilters.map((item) => <button key={item.value} className={filter === item.value ? 'active' : ''} onClick={() => setFilter(item.value)}>{item.label}</button>)}</nav>
      <section className="mobile-file-section"><div className="mobile-section-title"><div><h1>{filter === 'all' ? '所有文件' : mobileFilters.find((item) => item.value === filter)?.label}</h1><span>{visibleFiles.length} 项</span></div></div>
        <div className="mobile-file-list">{visibleFiles.length ? visibleFiles.map((file) => <article className="mobile-file-card" key={file.id}>
          <button className="mobile-file-main" onClick={() => openFile(file)}><FileThumbnail file={file} /><span className="mobile-file-info"><strong>{file.originalName}</strong><small>{formatBytes(file.byteSize)} · {formatDate(file.createdAt).split(' ')[0]}</small></span><span className="mobile-open"><Icon name="arrow" size={18} /></span></button>
          <button className="mobile-more" onClick={() => setDeleteTarget(file)} aria-label={`删除 ${file.originalName}`}><Icon name="more" /></button>
        </article>) : <div className="mobile-empty"><div><Icon name={query ? 'search' : 'files'} size={28} /></div><strong>{query ? '没有找到匹配文件' : '这里还没有文件'}</strong><span>{query ? '换个关键词或文件类型试试' : '请在 PC 端上传你的第一个文件'}</span></div>}</div>
      </section>
    </main>
    {preview && <MobileDocumentPreview file={preview} previousFile={previewImageIndex > 0 ? visibleImages[previewImageIndex - 1] : undefined} nextFile={previewImageIndex >= 0 ? visibleImages[previewImageIndex + 1] : undefined} onClose={() => setPreview(null)} onPrevious={previewImageIndex > 0 ? () => setPreview(visibleImages[previewImageIndex - 1]!) : undefined} onNext={previewImageIndex >= 0 && previewImageIndex < visibleImages.length - 1 ? () => setPreview(visibleImages[previewImageIndex + 1]!) : undefined} />}
    {audioFile && <MobileAudioPlayer file={audioFile} onClose={() => setAudioFile(null)} />}
    {deleteTarget && <DeleteSheet file={deleteTarget} busy={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeFile()} />}
  </div>;
}

function Workbench({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const mobile = useMobileLayout();
  const manager = useMemo(() => new UploadManager(user.id), [user.id]);
  const [uploads, setUploads] = useState<UploadView[]>([]); const [files, setFiles] = useState<FileRecord[]>([]); const [maxFileSizeBytes, setMaxFileSizeBytes] = useState<number | null>(null); const [dragging, setDragging] = useState(false); const [notice, setNotice] = useState(''); const [preview, setPreview] = useState<FileRecord | null>(null); const [activeFolder, setActiveFolder] = useState<'all' | MobileFileKind | null>(null); const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null); const [deleting, setDeleting] = useState(false); const input = useRef<HTMLInputElement>(null);
  const refreshFiles = async () => { try { setFiles(await api.files()); } catch (reason) { if (reason instanceof ApiError && reason.status === 401) { setFiles([]); onLogout(); return; } if (!(reason instanceof ApiError && reason.status === 404)) setNotice(reason instanceof Error ? reason.message : '文件列表加载失败'); } };
  useEffect(() => { manager.activate(); const unsubscribe = manager.subscribe(setUploads); void manager.restore().catch((reason) => setNotice(reason instanceof Error ? reason.message : '无法恢复本地上传记录')); void refreshFiles(); void api.config().then(({ maxFileSizeBytes: size }) => setMaxFileSizeBytes(size)).catch(() => setNotice('无法读取上传大小配置，将由服务端继续校验')); return () => { unsubscribe(); manager.destroy(); }; }, [manager]);
  const succeededCount = uploads.filter((item) => item.status === 'SUCCEEDED').length;
  useEffect(() => {
    if (!succeededCount) return;
    void api.files().then(setFiles).catch((reason) => setNotice(reason instanceof Error ? reason.message : '文件列表加载失败'));
  }, [succeededCount]);
  async function choose(selected: FileList | File[]) { const list = Array.from(selected); if (!list.length) return; const oversized = maxFileSizeBytes ? list.filter((file) => file.size > maxFileSizeBytes) : []; const accepted = maxFileSizeBytes ? list.filter((file) => file.size <= maxFileSizeBytes) : list; if (!accepted.length) { setNotice(`文件大小不能超过 ${formatBytes(maxFileSizeBytes!)}：${oversized.map((file) => file.name).join('、')}`); return; } try { const rejected = await manager.addFiles(accepted); const messages = [oversized.length ? `文件大小不能超过 ${formatBytes(maxFileSizeBytes!)}：${oversized.map((file) => file.name).join('、')}` : '', rejected.length ? `已忽略不支持的文件：${rejected.join('、')}` : ''].filter(Boolean); setNotice(messages.join('；')); } catch (reason) { setNotice(reason instanceof Error ? reason.message : '无法创建上传任务'); } }
  function download(file: FileRecord) {
    const link = document.createElement('a');
    link.href = api.downloadUrl(file.id);
    link.download = file.originalName;
    link.click();
  }
  async function removeFile() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteFile(deleteTarget.id);
      previewUrlCache.delete(deleteTarget.id);
      setFiles((current) => current.filter((file) => file.id !== deleteTarget.id));
      if (preview?.id === deleteTarget.id) setPreview(null);
      setDeleteTarget(null);
      setNotice('文件已删除');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  }
  function onInput(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) void choose(event.target.files); event.target.value = ''; }
  function onDrop(event: DragEvent) { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files); }
  if (mobile) return <MobileWorkbench user={user} files={files} notice={notice} onNotice={setNotice} onRefresh={refreshFiles} onLogout={onLogout} onFilesChange={setFiles} />;
  const folderFiles = activeFolder === null ? [] : files.filter((file) => activeFolder === 'all' || fileKind(file) === activeFolder);
  const previewImages = folderFiles.filter((file) => fileKind(file) === 'image');
  const previewImageIndex = preview && fileKind(preview) === 'image' ? previewImages.findIndex((file) => file.id === preview.id) : -1;
  const activeFolderLabel = mobileFilters.find((item) => item.value === activeFolder)?.label ?? '';
  return <div className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">R</span><span>Rock File</span></div><nav><a href="#uploads">上传任务</a><a href="#files">文件仓库</a></nav><div className="account"><span>{user.email}</span><button onClick={onLogout}>退出</button></div></header>
    <main className="workspace"><section className="welcome"><div><p className="eyebrow">传输控制台</p><h1>下午好，开始传输。</h1><p>支持单文件最高 {maxFileSizeBytes ? formatBytes(maxFileSizeBytes) : '读取中'}；分片数据从浏览器直达对象存储。</p></div><div className="network"><i className={navigator.onLine ? 'online' : ''} />{navigator.onLine ? '网络已连接' : '当前离线'}</div></section>
      <section className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop} onClick={() => input.current?.click()}><input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} onChange={onInput} /><div className="upload-symbol">↑</div><h2>拖拽文件到这里</h2><p>或点击选择多个文件 · 图片、音视频、PDF、TXT</p><button className="primary" type="button">选择文件</button></section>
      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
      <section id="uploads" className="content-section"><div className="section-head"><div><p className="eyebrow">实时队列</p><h2>上传任务</h2></div><span>{uploads.length} 个任务</span></div><div className="panel">{uploads.length ? uploads.map((item) => <UploadRow key={item.localId} item={item} manager={manager} />) : <div className="empty-state">还没有上传任务，将文件拖到上方开始。</div>}</div></section>
      <section id="files" className="content-section"><div className="section-head"><div><p className="eyebrow">云端内容</p><h2>{activeFolder === null ? '文件目录' : activeFolderLabel}</h2></div><div className="file-section-actions">{activeFolder !== null && <button onClick={() => setActiveFolder(null)}>返回目录</button>}<button onClick={() => void refreshFiles()}>刷新列表</button></div></div>
        {activeFolder === null ? <div className="folder-grid">{mobileFilters.map((folder) => { const count = folder.value === 'all' ? files.length : files.filter((file) => fileKind(file) === folder.value).length; return <button className="folder-card" key={folder.value} onClick={() => setActiveFolder(folder.value)}><span className={`folder-icon ${folder.value}`}><Icon name={folder.value === 'all' ? 'files' : folder.value} size={26} /></span><span><strong>{folder.label}</strong><small>{count} 个文件</small></span><Icon name="arrow" size={18} /></button>; })}</div>
        : <div className="file-grid">{folderFiles.length ? folderFiles.map((file) => <article className="file-card" key={file.id}><DesktopFileThumbnail file={file} /><div><strong title={file.originalName}>{file.originalName}</strong><p>{formatBytes(file.byteSize)} · {formatDate(file.createdAt)}</p></div><footer><span className={`status-pill ${file.status.toLowerCase()}`}>{file.status}</span><div><button disabled={file.status !== 'READY'} onClick={() => setPreview(file)}>预览</button><button disabled={file.status !== 'READY'} onClick={() => void download(file)}>下载</button><button className="danger-link" onClick={() => setDeleteTarget(file)}>删除</button></div></footer></article>) : <div className="empty-state grid-empty">该目录还没有文件。</div>}</div>}</section>
    </main>{preview && <PreviewModal file={preview} previousFile={previewImageIndex > 0 ? previewImages[previewImageIndex - 1] : undefined} nextFile={previewImageIndex >= 0 && previewImageIndex < previewImages.length - 1 ? previewImages[previewImageIndex + 1] : undefined} onClose={() => setPreview(null)} onPrevious={previewImageIndex > 0 ? () => setPreview(previewImages[previewImageIndex - 1]!) : undefined} onNext={previewImageIndex >= 0 && previewImageIndex < previewImages.length - 1 ? () => setPreview(previewImages[previewImageIndex + 1]!) : undefined} />}{deleteTarget && <DesktopDeleteDialog file={deleteTarget} busy={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeFile()} />}</div>;
}

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null); const [checking, setChecking] = useState(true);
  useEffect(() => { api.me().then((value) => setUser(unwrapUser(value))).catch(() => setUser(null)).finally(() => setChecking(false)); }, []);
  async function logout() { try { await api.logout(); } finally { setUser(null); } }
  if (checking) return <div className="boot"><span className="brand-mark">R</span><p>正在连接工作台…</p></div>;
  return user ? <Workbench user={user} onLogout={() => void logout()} /> : <Login onLogin={setUser} />;
}

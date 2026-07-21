import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
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
function formatDate(value: number) {
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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
    <section className="login-copy"><div className="brand"><span className="brand-mark">F</span><span>FlowDock</span></div><p className="eyebrow">大文件传输基础设施</p><h1>把超大文件，<br />稳稳送达。</h1><p className="hero-note">分片直传、断点恢复与浏览器端指纹计算，面向真实网络环境设计。</p><div className="feature-line"><span>01</span> 动态并发与智能重试</div><div className="feature-line"><span>02</span> 关闭页面后仍可恢复</div><div className="feature-line"><span>03</span> 内容校验与安全预览</div></section>
    <section className="login-panel"><div className="login-card"><p className="eyebrow">安全登录</p><h2>{challengeId ? '输入邮箱验证码' : '登录上传工作台'}</h2><p className="muted">{challengeId ? `验证码已发送至 ${email}` : '使用邮箱验证码确认身份，无需记住密码。'}</p>
      {!challengeId ? <form onSubmit={requestCode}><label>邮箱地址<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label><button className="primary wide" disabled={busy}>{busy ? '发送中…' : '获取验证码'}</button></form>
      : <form onSubmit={verify}><label>6 位验证码<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /></label><button className="primary wide" disabled={busy || code.length !== 6}>{busy ? '验证中…' : '进入工作台'}</button><button type="button" className="text-button" disabled={busy || cooldown > 0} onClick={() => void resend()}>{cooldown ? `${cooldown} 秒后可重新发送` : '重新发送验证码'}</button></form>}
      {error && <div className="error-banner" role="alert">{error}</div>}<p className="legal">继续即表示你同意仅上传拥有合法权限的内容。</p></div></section>
  </main>;
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
      <div className="upload-meta"><span>{item.status === 'UPLOADING' ? `${formatBytes(item.speed)}/s` : statusText[item.status]}</span><span>剩余 {formatEta(item.etaSeconds)}</span><span>{item.uploadedParts.length}/{item.totalParts ?? '—'} 分片</span></div>
      {item.error && <p className="inline-error">{item.error}</p>}
    </div>
    <div className="row-actions">{pausable && <button onClick={() => manager.pause(item.localId)}>暂停</button>}{resumable && <button onClick={() => manager.resume(item.localId)}>{item.needsFile ? '选择原文件' : '继续'}</button>}{!terminal && <button className="danger-link" onClick={() => void manager.cancel(item.localId)}>取消</button>}{terminal && <button onClick={() => void manager.remove(item.localId)}>移除</button>}</div>
  </article>;
}

function PreviewModal({ file, onClose }: { file: FileRecord; onClose: () => void }) {
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
        const ticket = await api.preview(file.id);
        if (!ticket.url) throw new Error('服务器未返回预览地址');
        if (!cancelled) setUrl(ticket.url);
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : '无法预览'); }
    })();
    return () => { cancelled = true; };
  }, [file]);
  const mime = file.detectedMime;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`${file.originalName} 预览`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="preview-modal"><header><div><p className="eyebrow">安全预览</p><h3>{file.originalName}</h3></div><button className="close" onClick={onClose} aria-label="关闭">×</button></header><div className="preview-stage">{error ? <div className="empty-state">{error}</div> : !url && !text ? <div className="loader">加载预览中…</div> : mime.startsWith('image/') ? <img src={url} alt={file.originalName} /> : mime.startsWith('video/') ? <video src={url} controls /> : mime.startsWith('audio/') ? <audio src={url} controls /> : mime === 'application/pdf' ? <iframe src={url} title={file.originalName} sandbox="allow-same-origin" /> : <pre>{text}</pre>}</div></div></div>;
}

function Workbench({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const manager = useMemo(() => new UploadManager(user.id), [user.id]);
  const [uploads, setUploads] = useState<UploadView[]>([]); const [files, setFiles] = useState<FileRecord[]>([]); const [dragging, setDragging] = useState(false); const [notice, setNotice] = useState(''); const [preview, setPreview] = useState<FileRecord | null>(null); const input = useRef<HTMLInputElement>(null);
  const refreshFiles = async () => { try { setFiles(await api.files()); } catch (reason) { if (reason instanceof ApiError && reason.status === 401) { setFiles([]); onLogout(); return; } if (!(reason instanceof ApiError && reason.status === 404)) setNotice(reason instanceof Error ? reason.message : '文件列表加载失败'); } };
  useEffect(() => { manager.activate(); const unsubscribe = manager.subscribe(setUploads); void manager.restore().catch((reason) => setNotice(reason instanceof Error ? reason.message : '无法恢复本地上传记录')); void refreshFiles(); return () => { unsubscribe(); manager.destroy(); }; }, [manager]);
  const succeededCount = uploads.filter((item) => item.status === 'SUCCEEDED').length;
  useEffect(() => {
    if (!succeededCount) return;
    void api.files().then(setFiles).catch((reason) => setNotice(reason instanceof Error ? reason.message : '文件列表加载失败'));
  }, [succeededCount]);
  async function choose(selected: FileList | File[]) { const list = Array.from(selected); if (!list.length) return; try { const rejected = await manager.addFiles(list); setNotice(rejected.length ? `已忽略不支持的文件：${rejected.join('、')}` : ''); } catch (reason) { setNotice(reason instanceof Error ? reason.message : '无法创建上传任务'); } }
  function download(file: FileRecord) {
    const link = document.createElement('a');
    link.href = api.downloadUrl(file.id);
    link.download = file.originalName;
    link.click();
  }
  function onInput(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) void choose(event.target.files); event.target.value = ''; }
  function onDrop(event: DragEvent) { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files); }
  return <div className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">F</span><span>FlowDock</span></div><nav><a href="#uploads">上传任务</a><a href="#files">文件仓库</a></nav><div className="account"><span>{user.email}</span><button onClick={onLogout}>退出</button></div></header>
    <main className="workspace"><section className="welcome"><div><p className="eyebrow">传输控制台</p><h1>下午好，开始传输。</h1><p>支持单文件最高 100 GB；分片数据从浏览器直达对象存储。</p></div><div className="network"><i className={navigator.onLine ? 'online' : ''} />{navigator.onLine ? '网络已连接' : '当前离线'}</div></section>
      <section className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop} onClick={() => input.current?.click()}><input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} onChange={onInput} /><div className="upload-symbol">↑</div><h2>拖拽文件到这里</h2><p>或点击选择多个文件 · 图片、音视频、PDF、TXT</p><button className="primary" type="button">选择文件</button></section>
      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
      <section id="uploads" className="content-section"><div className="section-head"><div><p className="eyebrow">实时队列</p><h2>上传任务</h2></div><span>{uploads.length} 个任务</span></div><div className="panel">{uploads.length ? uploads.map((item) => <UploadRow key={item.localId} item={item} manager={manager} />) : <div className="empty-state">还没有上传任务，将文件拖到上方开始。</div>}</div></section>
      <section id="files" className="content-section"><div className="section-head"><div><p className="eyebrow">云端内容</p><h2>服务器文件</h2></div><button onClick={() => void refreshFiles()}>刷新列表</button></div><div className="file-grid">{files.length ? files.map((file) => <article className="file-card" key={file.id}><div className={`file-cover ${file.detectedMime.split('/')[0]}`}><span>{file.originalName.split('.').pop()?.slice(0, 4).toUpperCase()}</span></div><div><strong title={file.originalName}>{file.originalName}</strong><p>{formatBytes(file.byteSize)} · {formatDate(file.createdAt)}</p></div><footer><span className={`status-pill ${file.status.toLowerCase()}`}>{file.status}</span><div><button disabled={file.status !== 'READY'} onClick={() => setPreview(file)}>预览</button><button disabled={file.status !== 'READY'} onClick={() => void download(file)}>下载</button></div></footer></article>) : <div className="empty-state grid-empty">服务器中暂无可用文件。</div>}</div></section>
    </main>{preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}</div>;
}

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null); const [checking, setChecking] = useState(true);
  useEffect(() => { api.me().then((value) => setUser(unwrapUser(value))).catch(() => setUser(null)).finally(() => setChecking(false)); }, []);
  async function logout() { try { await api.logout(); } finally { setUser(null); } }
  if (checking) return <div className="boot"><span className="brand-mark">F</span><p>正在连接工作台…</p></div>;
  return user ? <Workbench user={user} onLogout={() => void logout()} /> : <Login onLogin={setUser} />;
}

import {useEffect, useState} from 'react';
import {Hash, RotateCcw, Save} from 'lucide-react';
import type {CachePolicy} from '../shared/types';
import {api} from './api';

interface Props {
  side: 'a' | 'b';
  title: string;
  accent: string;
  draft: CachePolicy;
  /** hash the current run was computed with */
  boundHash?: string;
  /** hash of the draft currently selected in the editor slot */
  currentHash?: string;
  disabled?: boolean;
  onSaved: (hash: string, policy: CachePolicy) => void;
}

/**
 * Policy draft editor.
 * The editor edits a LOCAL copy; saving content-addresses a new hash. The run
 * stays bound to its old hash and is flagged stale ("旧结果已过期") until a new
 * run is started — old results are never overwritten.
 */
export function PolicyEditor({side, title, accent, draft, boundHash, currentHash, disabled, onSaved}: Props) {
  const [local, setLocal] = useState<CachePolicy>(draft);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setLocal(draft), [draft]);

  const update = <K extends keyof CachePolicy>(key: K, value: CachePolicy[K]) =>
    setLocal((p) => ({...p, [key]: value}));

  const stale = Boolean(boundHash && currentHash && boundHash !== currentHash);

  async function save() {
    setError(null);
    try {
      const stored = await api.savePolicy(local);
      await api.selectSlot(side, stored.hash);
      setSavedHash(stored.hash);
      onSaved(stored.hash, local);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`policy-card ${accent}`}>
      <div className="policy-head">
        <strong>{title}</strong>
        {boundHash && (
          <span className={`hash-chip ${stale ? 'stale' : 'fresh'}`} title="绑定本次运行结果的内容哈希">
            <Hash size={12}/>{boundHash}
            {stale && <em className="stale-flag">旧结果已过期</em>}
          </span>
        )}
      </div>
      <fieldset disabled={disabled} className="policy-grid">
        <label>名称<input value={local.name} onChange={(e) => update('name', e.target.value)}/></label>
        <label>maxAge（新鲜期 tick）
          <input type="number" min={0} value={local.maxAge} onChange={(e) => update('maxAge', Number(e.target.value))}/>
        </label>
        <label>stale-while-revalidate
          <input type="number" min={0} value={local.staleWhileRevalidate} onChange={(e) => update('staleWhileRevalidate', Number(e.target.value))}/>
        </label>
        <label>stale-if-error
          <input type="number" min={0} value={local.staleIfError} onChange={(e) => update('staleIfError', Number(e.target.value))}/>
        </label>
        <label>缓存容量（条目）
          <input type="number" min={1} value={local.capacity} onChange={(e) => update('capacity', Number(e.target.value))}/>
        </label>
        <label className="check">
          <input type="checkbox" checked={local.coalesce} onChange={(e) => update('coalesce', e.target.checked)}/>
          并发请求合并（coalesce）
        </label>
      </fieldset>
      <div className="policy-foot">
        <button className="small primary" onClick={save} disabled={disabled}>
          <Save size={13}/>保存草稿（按内容哈希）
        </button>
        <button className="small ghost" onClick={() => {setLocal(draft); setSavedHash(null);}} disabled={disabled}>
          <RotateCcw size={13}/>还原
        </button>
        {savedHash && <span className="ok">已保存 {savedHash}</span>}
        {error && <span className="err">{error}</span>}
      </div>
    </div>
  );
}

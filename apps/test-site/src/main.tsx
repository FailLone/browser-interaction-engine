import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import './style.css';
import './rule-defects.css';
const ruleDefects = import.meta.env.VITE_RULE_DEFECTS !== 'off' && new URLSearchParams(location.search).get('defects') !== 'off';
function App() {
  const [mode, setMode] = useState('Limit'); const [menu, setMenu] = useState(false);
  const [pair, setPair] = useState('BTC/USDT'); const [unit, setUnit] = useState('USDT');
  const [amount, setAmount] = useState(''); const [price, setPrice] = useState('');
  const [generation, setGeneration] = useState(0); const [settings, setSettings] = useState(false);
  const [duplicate, setDuplicate] = useState(false); const [submitted, setSubmitted] = useState(0);
  const [refresh, setRefresh] = useState(false); const [tick, setTick] = useState(0);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); setSettings(false); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  useEffect(() => { if (!refresh) return; const timer = setInterval(() => setTick(t => t + 1), 70); return () => clearInterval(timer); }, [refresh]);
  const reset = <button id="reset-interface" onClick={() => { setMode('Limit'); setMenu(false); setSettings(false); setAmount(''); setPrice(''); }}>Reset interface</button>;
  const done = <button onClick={() => setSettings(false)}>Done</button>;
  return <main className={ruleDefects ? 'rule-defects' : undefined}>
    <header><span className="eyebrow">INTERACTION LAB / TEST ENVIRONMENT</span><h1>Order workspace</h1><p>A small exchange built to exercise identity, context and verified recovery.</p></header>
    {ruleDefects && <p className="defect-notice">布局缺陷已开启：提交按钮文字截断、Reset interface 被遮挡，Other settings 弹层中的 Done 按钮被裁切。用于验证遍历中的规则检查。</p>}
    <form id="order-form" aria-label="Order form" onSubmit={e => { e.preventDefault(); setSubmitted(n => n + 1); }}>
      <div className="grid"><label>Trading pair<select id="pair" value={pair} onChange={e => { setPair(e.target.value); setGeneration(n => n + 1); }}><option>BTC/USDT</option><option>ETH/USDT</option></select></label>
      <div><span id="order-type-label">Order type</span><button type="button" id="order-type" aria-labelledby="order-type-label" aria-expanded={menu} aria-controls="order-menu" onClick={() => setMenu(v => !v)}>{mode} <span>⌄</span></button></div></div>
      {mode === 'Limit' && <label>Price<input key={`price-${generation}`} id="price" type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)} /></label>}
      <div className="grid"><label>Amount<input key={`amount-${generation}`} id="amount" type="number" min={pair.startsWith('BTC') ? '0.001' : '0.01'} step={pair.startsWith('BTC') ? '0.001' : '0.01'} value={amount} onChange={e => setAmount(e.target.value)} /></label><label>Amount unit<select id="unit" value={unit} onChange={e => setUnit(e.target.value)}><option>USDT</option><option>Base asset</option></select></label></div>
      <label className="check"><input id="post-only" type="checkbox" /> Post only</label>
      <button type="button" id="settings" aria-expanded={settings} aria-controls="settings-dialog" onClick={() => setSettings(true)}>Other settings</button>
      <button className="primary" type="submit" id="submit">Submit test order</button>
      <output aria-label="Submitted orders">Submitted orders: {submitted}</output>
    </form>
    <section aria-label="Test controls"><h2>Identity & recovery fixtures</h2><div className="tools">
      <button id="rebuild" onClick={() => setGeneration(n => n + 1)}>Rebuild inputs</button>
      <button id="duplicate" aria-expanded={duplicate} onClick={() => setDuplicate(v => !v)}>Duplicate controls</button>
      <button id="quick-market" onClick={() => { setMode('Market'); setMenu(false); }}>Quick Market</button>
      {ruleDefects ? <span className="defect-covered">{reset}<span className="defect-cover" aria-hidden="true">遮挡层</span></span> : reset}
      <label className="check"><input id="background" type="checkbox" checked={refresh} onChange={e => setRefresh(e.target.checked)} /> Background refresh</label>
      {refresh && <input aria-label={`Live quote ${tick}`} value={tick} readOnly />}
      {duplicate && <div><label>Reference<input type="text" /></label><label>Reference<input type="text" /></label></div>}
    </div></section>
    {menu && createPortal(<div id="order-menu" role="menu" aria-label="Order types" className="overlay menu"><button role="menuitem" onClick={() => { setMode('Limit'); setMenu(false); }}>Limit</button><button role="menuitem" onClick={() => { setMode('Market'); setMenu(false); }}>Market</button></div>, document.body)}
    {settings && createPortal(<div className="backdrop"><div role="dialog" id="settings-dialog" aria-label="Other settings" className="overlay"><h2>Other settings</h2><label>Time in force<select id="time-in-force"><option>GTC</option><option>IOC</option></select></label>{ruleDefects ? <><p>故意裁切按钮右侧，验证进入弹层后的检查。</p><div className="defect-modal-clip">{done}</div></> : done}</div></div>, document.body)}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
